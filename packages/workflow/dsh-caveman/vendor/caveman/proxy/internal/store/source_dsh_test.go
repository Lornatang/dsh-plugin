package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func writeDSHFixture(t *testing.T, path string, rows []map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	var data strings.Builder
	for _, row := range rows {
		line, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		data.Write(line)
		data.WriteByte('\n')
	}
	content := []byte(data.String())
	if strings.HasSuffix(path, ".zstd") {
		encoder, err := zstd.NewWriter(nil)
		if err != nil {
			t.Fatal(err)
		}
		content = encoder.EncodeAll(content, nil)
		encoder.Close()
	}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestDSHSourceReadsUsageToolResultsAndSeedBoundaries(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC().Truncate(time.Millisecond)
	event := func(kind string, seq int, data map[string]any) map[string]any {
		return map[string]any{"type": kind, "seq": seq, "time": now.UnixMilli(), "data": data}
	}
	file := filepath.Join(root, "project", "child", "session.v4.jsonl.zstd")
	writeDSHFixture(t, file, []map[string]any{
		{"type": "session", "version": 4, "id": "child", "createdAt": now.UnixMilli(), "cwd": "/fixture", "isSeeded": true, "origin": "subagent", "parentSession": "parent", "delegationDepth": 1},
		event("assistant/message", 1, map[string]any{"message": map[string]any{"id": "inherited", "content": []any{}}, "usage": map[string]any{"inputTokens": 1000, "outputTokens": 7}}),
		event("session/end-seed", 2, map[string]any{"inherited": true}),
		event("request/context", 3, map[string]any{"provider": "fixture", "model": "model"}),
		event("user/message", 4, map[string]any{"id": "prompt", "source": map[string]any{"kind": "user"}, "content": []any{map[string]any{"type": "text", "text": "human text"}}}),
		event("user/message", 5, map[string]any{"id": "injected", "source": map[string]any{"kind": "dsh-caveman-mode"}, "content": []any{map[string]any{"type": "text", "text": "automatic instruction"}}}),
		event("assistant/message", 6, map[string]any{"message": map[string]any{"id": "answer", "content": []any{}}, "usage": map[string]any{"inputTokens": 10, "cacheReadTokens": 20, "cacheWriteTokens": 4, "outputTokens": 5}}),
		event("tool/call", 7, map[string]any{"callId": "call-1", "name": "read", "arguments": `{"path":"fixture.txt"}`}),
		event("tool/result", 8, map[string]any{"message": map[string]any{"id": "result", "toolCallId": "call-1", "content": []any{map[string]any{"type": "text", "text": "fixture output"}}}}),
	})
	// A previous generation is retained on disk after migration; count the session once.
	writeDSHFixture(t, filepath.Join(filepath.Dir(file), "session.v3.jsonl.zstd"), []map[string]any{{"type": "session", "version": 3}})
	source := dshSessionSource{root: root}
	refs, truncated := source.discover(nil)
	if truncated || len(refs) != 1 || refs[0].path != file {
		t.Fatalf("discovery = %+v, truncated %v", refs, truncated)
	}
	var events []turnEvent
	if source.scanSession(refs[0], now.Add(-time.Hour), func(event turnEvent) { events = append(events, event) }, nil) {
		t.Fatal("unexpected deadline")
	}
	var usage, tool int
	var texts []string
	for _, event := range events {
		texts = append(texts, event.TextPayloads...)
		if event.ContextUsagePresent {
			usage++
			if event.ContextTotal != 34 || event.InputFreshTokens != 10 || event.CacheReadInputTokens != 20 || event.CacheCreationInputTokens != 4 || event.OutputTokens != 5 || event.ProviderKey != "fixture" || event.Model != "model" || !event.Side {
				t.Fatalf("incorrect usage: %+v", event)
			}
		}
		for _, call := range event.ToolCalls {
			tool++
			if call.Name != "read" || call.InputSummary != "fixture.txt" || call.OutputText != "fixture output" {
				t.Fatalf("incorrect tool result: %+v", call)
			}
		}
	}
	if usage != 1 || tool != 1 || strings.Join(texts, "|") != "human text" {
		t.Fatalf("usage=%d tool=%d texts=%q", usage, tool, texts)
	}
}

func TestDSHSourceRegistrationAndUnknownUsage(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CAVEMAN_DSH_SESSION_ROOT", root)
	path := filepath.Join(root, "project", "session", "session.v4.jsonl")
	now := time.Now().UTC()
	writeDSHFixture(t, path, []map[string]any{
		{"type": "session", "version": 4, "id": "session", "createdAt": now.UnixMilli(), "isSeeded": false, "delegationDepth": 0},
		{"type": "assistant/message", "seq": 1, "time": now.UnixMilli(), "data": map[string]any{"message": map[string]any{"id": "no-cache-fields"}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 3}}},
		{"type": "assistant/message", "seq": 2, "time": now.UnixMilli(), "data": map[string]any{"message": map[string]any{"id": "total"}, "usage": map[string]any{"inputTokens": 10, "outputTokens": 3, "totalTokens": 23}}},
	})
	if !normalizeSources(nil)["dsh"] {
		t.Fatal("DSH is missing from default learn sources")
	}
	var source sessionSource
	for _, candidate := range learnSessionSources() {
		if candidate.id() == "dsh" {
			source = candidate
		}
	}
	if source == nil {
		t.Fatal("DSH source is not registered")
	}
	refs, _ := source.discover(nil)
	if len(refs) != 1 {
		t.Fatalf("discovered %d sessions", len(refs))
	}
	var messages []turnEvent
	source.scanSession(refs[0], time.Time{}, func(event turnEvent) {
		if event.UsageMessageID != "" {
			messages = append(messages, event)
		}
	}, nil)
	if len(messages) != 2 || messages[0].ContextUsagePresent || messages[0].BillingUsagePresent {
		t.Fatalf("unknown cache fields must not be treated as zero: %+v", messages)
	}
	if !messages[1].ContextUsagePresent || messages[1].ContextTotal != 20 || messages[1].BillingUsagePresent {
		t.Fatalf("total minus output is exact, but billing remains unknown: %+v", messages[1])
	}
}

func TestDSHSourceRefusesNewerOrAmbiguousGenerations(t *testing.T) {
	root := t.TempDir()
	writeDSHFixture(t, filepath.Join(root, "future", "session.v4.jsonl"), []map[string]any{{"type": "session", "version": 4}})
	writeDSHFixture(t, filepath.Join(root, "future", "session.v5.jsonl"), []map[string]any{{"type": "session", "version": 5}})
	writeDSHFixture(t, filepath.Join(root, "ambiguous", "session.v4.jsonl"), []map[string]any{{"type": "session", "version": 4}})
	writeDSHFixture(t, filepath.Join(root, "ambiguous", "session.v4.jsonl.zstd"), []map[string]any{{"type": "session", "version": 4}})
	refs, _ := (dshSessionSource{root: root}).discover(nil)
	if len(refs) != 0 {
		t.Fatalf("unsupported or ambiguous sessions were selected: %+v", refs)
	}
}

func TestDSHSourceKeepsSequenceZeroAndEmptyForkSeed(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UnixMilli()
	header := func(id string, seeded bool) map[string]any {
		return map[string]any{"type": "session", "version": 4, "id": id, "createdAt": now, "isSeeded": seeded, "delegationDepth": 0}
	}
	message := func(seq int) map[string]any {
		return map[string]any{"type": "user/message", "seq": seq, "time": now, "data": map[string]any{"source": map[string]any{"kind": "user"}, "content": []any{map[string]any{"type": "text", "text": "own"}}}}
	}
	writeDSHFixture(t, filepath.Join(root, "plain", "session.v4.jsonl"), []map[string]any{header("plain", false), message(0)})
	writeDSHFixture(t, filepath.Join(root, "seed", "session.v4.jsonl"), []map[string]any{header("seed", true), {"type": "session/end-seed", "seq": 0, "time": now, "data": map[string]any{"inherited": true}}, message(1)})
	source := dshSessionSource{root: root}
	refs, _ := source.discover(nil)
	if len(refs) != 2 {
		t.Fatalf("discovered %d sessions", len(refs))
	}
	for _, ref := range refs {
		var texts []string
		source.scanSession(ref, time.Time{}, func(event turnEvent) { texts = append(texts, event.TextPayloads...) }, nil)
		if strings.Join(texts, "|") != "own" {
			t.Fatalf("%s: %q", ref.relPath, texts)
		}
	}
}

func TestDSHLocatorReturnsOnlyTheVerifiedHumanBlock(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CAVEMAN_DSH_SESSION_ROOT", root)
	path := filepath.Join(root, "project", "session", "session.v4.jsonl.zstd")
	block := "the real block\nwith a second line"
	writeDSHFixture(t, path, []map[string]any{
		{"type": "session", "version": 4, "id": "session", "createdAt": 1, "isSeeded": false, "delegationDepth": 0},
		{"type": "user/message", "seq": 0, "time": 1, "data": map[string]any{"source": map[string]any{"kind": "user"}, "content": []any{map[string]any{"type": "text", "text": "first\n\n" + block}}}},
		{"type": "user/message", "seq": 1, "time": 2, "data": map[string]any{"source": map[string]any{"kind": "plugin"}, "content": []any{map[string]any{"type": "text", "text": block}}}},
	})
	rel, err := filepath.Rel(root, path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadDSHLocator(rel, 2, 1, contentSHA256(block))
	if err != nil || got != block {
		t.Fatalf("locator = %q, %v", got, err)
	}
	for _, test := range []struct {
		path        string
		line, index int
		hash        string
	}{
		{rel, 2, 1, contentSHA256("changed")}, {rel, 3, 0, contentSHA256(block)},
		{filepath.Join("..", "outside"), 2, 0, contentSHA256(block)}, {path, 2, 0, contentSHA256(block)},
	} {
		if _, err := ReadDSHLocator(test.path, test.line, test.index, test.hash); err == nil {
			t.Fatalf("accepted unsafe or stale locator: %+v", test)
		}
	}
}

func TestDSHSourceReadsReleasedHistoricalGenerations(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UnixMilli()
	for version := 0; version <= 3; version++ {
		header := map[string]any{"type": "session", "version": version, "id": fmt.Sprintf("session-%d", version), "createdAt": now, "delegationDepth": 0}
		if version < 2 {
			header["seedLength"] = 1
		} else {
			header["isSeeded"] = true
		}
		seed := map[string]any{"type": "assistant/message", "seq": 0, "time": now, "data": map[string]any{"usage": map[string]any{"inputTokens": 999, "outputTokens": 1, "totalTokens": 1000}}}
		rows := []map[string]any{header, seed}
		seq := 1
		if version >= 2 {
			rows = append(rows, map[string]any{"type": "session/end-seed", "seq": seq, "time": now, "data": map[string]any{"inherited": true}})
			seq++
		}
		rows = append(rows,
			map[string]any{"type": "user/message", "seq": seq, "time": now, "data": map[string]any{"source": map[string]any{"kind": "user"}, "content": []any{map[string]any{"type": "text", "text": "historical prompt"}}}},
			map[string]any{"type": "tool/call", "seq": seq + 1, "time": now, "data": map[string]any{"callId": "call", "name": "read", "arguments": `{"path":"old.txt"}`}},
		)
		result := map[string]any{"callId": "call", "content": []any{map[string]any{"type": "text", "text": "historical output"}}, "isError": false}
		if version >= 2 {
			result = map[string]any{"message": map[string]any{"role": "user", "source": map[string]any{"kind": "tool", "callId": "call"}, "content": []any{map[string]any{"type": "tool-result", "toolCallId": "call", "content": result["content"], "isError": false}}}}
		}
		rows = append(rows,
			map[string]any{"type": "tool/result", "seq": seq + 2, "time": now, "data": result},
			map[string]any{"type": "assistant/message", "seq": seq + 3, "time": now, "data": map[string]any{"usage": map[string]any{"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}},
		)
		name := "session.jsonl"
		if version > 0 {
			name = fmt.Sprintf("session.v%d.jsonl", version)
		}
		writeDSHFixture(t, filepath.Join(root, fmt.Sprintf("v%d", version), name), rows)
	}
	source := dshSessionSource{root: root}
	refs, _ := source.discover(nil)
	if len(refs) != 4 {
		t.Fatalf("discovered %d historical sessions", len(refs))
	}
	for _, ref := range refs {
		var texts []string
		var usages, calls int
		source.scanSession(ref, time.Time{}, func(event turnEvent) {
			texts = append(texts, event.TextPayloads...)
			if event.ContextUsagePresent {
				usages++
				if event.ContextTotal != 10 {
					t.Fatalf("%s: usage %+v", ref.path, event)
				}
			}
			for _, call := range event.ToolCalls {
				calls++
				if call.InputSummary != "old.txt" || call.OutputText != "historical output" {
					t.Fatalf("%s: call %+v", ref.path, call)
				}
			}
		}, nil)
		if usages != 1 || calls != 1 || strings.Join(texts, "|") != "historical prompt" {
			t.Fatalf("%s: usage %d calls %d texts %q", ref.path, usages, calls, texts)
		}
	}
}

func TestDSHSourceCountsCatalogChildrenOnceAtTheirCreationTime(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	path := filepath.Join(root, "session.v4.jsonl")
	writeDSHFixture(t, path, []map[string]any{
		{"type": "session", "version": 4, "id": "parent", "createdAt": now.UnixMilli(), "isSeeded": false, "delegationDepth": 0},
		{"type": "tool/call", "seq": 0, "time": now.UnixMilli(), "data": map[string]any{"callId": "call", "name": "subagent", "arguments": "{}"}},
		{"type": "subagent/catalog", "seq": 1, "time": now.UnixMilli(), "data": map[string]any{"childId": "child", "childCreatedAt": now.UnixMilli(), "mode": "continuable"}},
		{"type": "subagent/catalog", "seq": 2, "time": now.UnixMilli(), "data": map[string]any{"childId": "child", "childCreatedAt": now.UnixMilli(), "mode": "continuable"}},
		{"type": "subagent/catalog", "seq": 3, "time": now.UnixMilli(), "data": map[string]any{"childId": "old", "childCreatedAt": now.Add(-2 * time.Hour).UnixMilli(), "mode": "unknown"}},
	})
	source := dshSessionSource{root: root}
	refs, _ := source.discover(nil)
	var lines []int
	source.scanSession(refs[0], now.Add(-time.Hour), func(event turnEvent) {
		if event.TaskSpawns > 0 {
			lines = append(lines, event.JSONLLine)
		}
	}, nil)
	if len(lines) != 1 || lines[0] != 3 {
		t.Fatalf("child creation lines = %v, want the first recent catalog fact only", lines)
	}
}

func TestDSHSourceDoesNotRemineProjectedOldUserMessages(t *testing.T) {
	root := t.TempDir()
	now := time.Now().UTC()
	path := filepath.Join(root, "session.v4.jsonl")
	message := func(seq int, when time.Time, id, text string) map[string]any {
		return map[string]any{"type": "user/message", "seq": seq, "time": when.UnixMilli(), "data": map[string]any{"id": id, "source": map[string]any{"kind": "user"}, "content": []any{map[string]any{"type": "text", "text": text}}}}
	}
	writeDSHFixture(t, path, []map[string]any{
		{"type": "session", "version": 4, "id": "session", "createdAt": now.Add(-2 * time.Hour).UnixMilli(), "isSeeded": false, "delegationDepth": 0},
		message(0, now.Add(-2*time.Hour), "same-id", "old"), message(1, now, "same-id", "old"), message(2, now, "new-id", "new"),
	})
	writeDSHFixture(t, filepath.Join(root, "seed", "session.v4.jsonl"), []map[string]any{
		{"type": "session", "version": 4, "id": "seed", "createdAt": now.UnixMilli(), "isSeeded": true, "delegationDepth": 1},
		message(0, now, "same-id", "old"), {"type": "session/end-seed", "seq": 1, "time": now.UnixMilli(), "data": map[string]any{"inherited": true}},
		message(2, now, "same-id", "old"), message(3, now, "new-id", "new"),
	})
	source := dshSessionSource{root: root}
	refs, _ := source.discover(nil)
	if len(refs) != 2 {
		t.Fatalf("discovered %d sessions", len(refs))
	}
	for _, ref := range refs {
		var texts []string
		source.scanSession(ref, now.Add(-time.Hour), func(event turnEvent) { texts = append(texts, event.TextPayloads...) }, nil)
		if strings.Join(texts, "|") != "new" {
			t.Fatalf("%s: recent human inputs = %q, want only the new message", ref.relPath, texts)
		}
	}
}
