package store

import (
	"bufio"
	"encoding/json"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// DSH saves one versioned, optionally zstd-compressed event log per session.
// Historical generations remain in the directory after migration: selecting a
// single newest generation is essential to avoid counting a session twice.
type dshSessionSource struct{ root string }

func (s dshSessionSource) id() string { return "dsh" }

func dshSessionRoot() string {
	if root := strings.TrimSpace(os.Getenv("CAVEMAN_DSH_SESSION_ROOT")); root != "" {
		return root
	}
	if root := strings.TrimSpace(os.Getenv("DSH_HOME")); root != "" {
		return filepath.Join(root, "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".dsh", "sessions")
}

var dshLogName = regexp.MustCompile(`^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$`)

func (s dshSessionSource) discover(deadline *behaviorDeadline) ([]sessionRef, bool) {
	return s.discoverUntil(func() bool { return deadline != nil && deadline.expired() })
}

func (s dshSessionSource) discoverUntil(expired func() bool) ([]sessionRef, bool) {
	if s.root == "" {
		return nil, false
	}
	type generation struct {
		version   int
		path      string
		ambiguous bool
	}
	latest := map[string]generation{}
	timedOut := false
	_ = filepath.WalkDir(s.root, func(path string, entry fs.DirEntry, err error) error {
		if expired != nil && expired() {
			timedOut = true
			return fs.SkipAll
		}
		if err != nil || entry == nil || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		match := dshLogName.FindStringSubmatch(entry.Name())
		if match == nil {
			return nil
		}
		version := 0
		if match[1] != "" {
			value, err := strconv.Atoi(match[1])
			if err != nil {
				return nil
			}
			version = value
		}
		dir := filepath.Dir(path)
		previous, ok := latest[dir]
		if !ok || version > previous.version {
			latest[dir] = generation{version: version, path: path}
		} else if version == previous.version && path != previous.path {
			previous.ambiguous = true
			latest[dir] = previous
		}
		return nil
	})
	refs := make([]sessionRef, 0, len(latest))
	for _, gen := range latest {
		// Refuse formats whose semantics this reader cannot establish. In
		// particular, never fall back to a stale generation after an upgrade.
		if gen.version > 4 || gen.ambiguous {
			continue
		}
		rel, err := filepath.Rel(s.root, gen.path)
		if err != nil {
			continue
		}
		refs = append(refs, sessionRef{path: gen.path, relPath: rel, repoProvisional: true})
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].relPath < refs[j].relPath })
	return refs, timedOut
}

func dshScanner(path string) (*bufio.Scanner, func(), error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	var reader io.Reader = f
	closeReader := func() { _ = f.Close() }
	if strings.HasSuffix(path, ".zstd") {
		decoder, err := zstd.NewReader(f, zstd.WithDecoderMaxMemory(64<<20))
		if err != nil {
			_ = f.Close()
			return nil, nil, err
		}
		reader = decoder
		closeReader = func() { decoder.Close(); _ = f.Close() }
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
	return scanner, closeReader, nil
}

func dshInt(value any) (int64, bool) {
	n, ok := value.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > (1<<53)-1 || math.Trunc(n) != n {
		return 0, false
	}
	return int64(n), true
}

// DSH generations before the tool-role format wrapped tool results in a user
// message; the oldest format kept the call and content directly in event data.
func dshToolResult(data map[string]any) (string, any, bool) {
	message := asMap(data["message"])
	if id := firstString(message["toolCallId"]); id != "" {
		return id, message["content"], message["isError"] == true
	}
	if firstString(message["role"]) == "user" && firstString(asMap(message["source"])["kind"]) == "tool" {
		id := firstString(asMap(message["source"])["callId"])
		blocks, ok := message["content"].([]any)
		if id != "" && ok && len(blocks) == 1 {
			wrapper := asMap(blocks[0])
			if wrapper["type"] == "tool-result" && firstString(wrapper["toolCallId"]) == id {
				return id, wrapper["content"], wrapper["isError"] == true
			}
		}
	}
	return firstString(data["callId"]), data["content"], data["isError"] == true
}

func (s dshSessionSource) scanSession(ref sessionRef, since time.Time, emit func(turnEvent), deadline *behaviorDeadline) bool {
	if deadline != nil && deadline.expired() {
		return true
	}
	scanner, closeReader, err := dshScanner(ref.path)
	if err != nil {
		return false
	}
	defer func() { closeReader() }()
	if !scanner.Scan() {
		return false
	}
	var header map[string]any
	if json.Unmarshal(scanner.Bytes(), &header) != nil || header["type"] != "session" {
		return false
	}
	version, valid := dshInt(header["version"])
	match := dshLogName.FindStringSubmatch(filepath.Base(ref.path))
	if !valid || version > 4 || match == nil || (version == 0 && match[1] != "") || (version > 0 && match[1] != strconv.FormatInt(version, 10)) || firstString(header["id"]) == "" {
		return false
	}
	seeded := false
	seedLength := int64(0)
	if version < 2 {
		if raw, exists := header["seedLength"]; exists {
			seedLength, valid = dshInt(raw)
			if !valid {
				return false
			}
			seeded = true
		}
	} else {
		seeded, valid = header["isSeeded"].(bool)
		if !valid {
			return false
		}
	}
	repo := firstString(header["cwd"])
	side := header["origin"] == "subagent"
	provider, model := "", ""
	seedCut := int64(0)
	seedMarker := false
	if seeded && version >= 2 {
		currentProvider, currentModel := "", ""
		for scanner.Scan() {
			if deadline != nil && deadline.expired() {
				return true
			}
			var row map[string]any
			if json.Unmarshal(scanner.Bytes(), &row) != nil {
				continue
			}
			data := asMap(row["data"])
			if row["type"] == "request/context" {
				currentProvider, currentModel = firstString(data["provider"]), firstString(data["model"])
			}
			if row["type"] == "session/end-seed" && data["inherited"] == true {
				if cut, valid := dshInt(row["seq"]); valid {
					seedCut, seedMarker = cut, true
					provider, model = currentProvider, currentModel
				}
			}
		}
		if !seedMarker || scanner.Err() != nil {
			return false
		}
		closeReader()
		scanner, closeReader, err = dshScanner(ref.path)
		if err != nil {
			closeReader = func() {}
			return false
		}
		if !scanner.Scan() {
			return false
		}
	}
	emit(turnEvent{sessionStart: true, RelPath: ref.relPath, Repo: repo})
	pending := map[string]turnToolCall{}
	seenUsers := map[string]bool{}
	seenChildren := map[string]bool{}
	lineNo := 1
	for scanner.Scan() {
		lineNo++
		if deadline != nil && deadline.expired() {
			return true
		}
		var row map[string]any
		if json.Unmarshal(scanner.Bytes(), &row) != nil {
			continue
		}
		seq, valid := dshInt(row["seq"])
		if !valid {
			continue
		}
		kind := firstString(row["type"])
		data := asMap(row["data"])
		duplicateUser := false
		if kind == "user/message" && firstString(asMap(data["source"])["kind"]) == "user" {
			id := firstString(data["id"])
			if id != "" {
				duplicateUser, seenUsers[id] = seenUsers[id], true
			}
		}
		if (seeded && version < 2 && seq < seedLength) || (seeded && version >= 2 && seq <= seedCut) {
			continue
		}
		if kind == "request/context" {
			provider, model = firstString(data["provider"], provider), firstString(data["model"], model)
		}
		if kind == "tool/call" {
			id, name := firstString(data["callId"]), firstString(data["name"])
			args := data["arguments"]
			if text, ok := args.(string); ok {
				_ = json.Unmarshal([]byte(text), &args)
			}
			if id != "" && name != "" {
				pending[id] = turnToolCall{Name: name, InputSummary: toolInputSummary(args)}
			}
		}
		ms, valid := dshInt(row["time"])
		if !valid {
			continue
		}
		ts := time.UnixMilli(ms).UTC()
		if !since.IsZero() && ts.Before(since) {
			if kind == "tool/result" {
				id, _, _ := dshToolResult(data)
				delete(pending, id)
			}
			continue
		}
		out := turnEvent{Timestamp: ts, JSONLLine: lineNo, RelPath: ref.relPath, Repo: repo, Side: side, ProviderKey: provider, Model: model}
		switch kind {
		case "user/message":
			if firstString(asMap(data["source"])["kind"]) == "user" && !duplicateUser {
				out.TextPayloads = piTextPayloads("user", data)
			}
		case "assistant/message":
			message := asMap(data["message"])
			out.UsageMessageID = firstString(message["id"])
			if out.UsageMessageID == "" {
				out.UsageMessageID = "seq:" + strconv.FormatInt(seq, 10)
			}
			usage := asMap(data["usage"])
			input, hasInput := dshInt(usage["inputTokens"])
			output, hasOutput := dshInt(usage["outputTokens"])
			read, hasRead := dshInt(usage["cacheReadTokens"])
			write, hasWrite := dshInt(usage["cacheWriteTokens"])
			if hasInput && hasOutput && hasRead && hasWrite {
				if total, valid := checkedNonNegativeSum(input, read, write); valid && total <= math.MaxInt {
					out.ContextTotal, out.ContextUsagePresent = int(total), true
					out.InputFreshTokens, out.OutputTokens, out.BillingUsagePresent = int(input), int(output), true
					out.CacheReadInputTokens, out.CacheCreationInputTokens, out.CacheUsagePresent = int(read), int(write), true
				}
			} else if total, hasTotal := dshInt(usage["totalTokens"]); hasTotal && hasOutput && total >= output && total-output <= math.MaxInt {
				out.ContextTotal, out.ContextUsagePresent = int(total-output), true
			}
		case "subagent/catalog":
			id := firstString(data["childId"])
			created, valid := dshInt(data["childCreatedAt"])
			if id != "" && valid && !seenChildren[id] && (since.IsZero() || !time.UnixMilli(created).Before(since)) {
				seenChildren[id] = true
				out.TaskSpawns = 1
			}
		case "tool/result":
			id, content, isError := dshToolResult(data)
			if call, ok := pending[id]; ok {
				delete(pending, id)
				call.IsError = isError
				call.OutputText = toolResultText(content)
				out.ToolCalls = []turnToolCall{call}
			}
		case "compaction/end":
			out.Compaction = data["error"] == nil
		}
		emit(out)
	}
	return false
}
