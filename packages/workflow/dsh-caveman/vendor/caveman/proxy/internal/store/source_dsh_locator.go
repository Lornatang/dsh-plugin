package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/klauspost/compress/zstd"
)

var dshDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ReadDSHLocator re-reads one human-authored block without copying a transcript
// to a temporary file. The digest prevents acting on a changed session.
func ReadDSHLocator(relative string, line, block int, digest string) (string, error) {
	if !filepath.IsLocal(relative) || dshLogName.FindStringSubmatch(filepath.Base(relative)) == nil || line < 2 || line > 5000000 || block < 0 || block > 100000 || !dshDigest.MatchString(digest) {
		return "", errors.New("invalid DSH locator")
	}
	root, err := os.OpenRoot(dshSessionRoot())
	if err != nil {
		return "", err
	}
	defer root.Close()
	file, err := root.Open(relative)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("DSH locator is not a regular file")
	}
	var input io.Reader = file
	if strings.HasSuffix(relative, ".zstd") {
		decoder, err := zstd.NewReader(file, zstd.WithDecoderMaxMemory(64<<20))
		if err != nil {
			return "", err
		}
		defer decoder.Close()
		input = decoder
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for current := 1; scanner.Scan(); current++ {
		if current != line {
			continue
		}
		var event map[string]any
		if json.Unmarshal(scanner.Bytes(), &event) != nil || event["type"] != "user/message" {
			return "", errors.New("DSH locator does not name a user message")
		}
		data := asMap(event["data"])
		if firstString(asMap(data["source"])["kind"]) != "user" {
			return "", errors.New("DSH locator does not name human input")
		}
		blocks := minableBlocks(piTextPayloads("user", data))
		if block >= len(blocks) || blocks[block].injected || contentSHA256(blocks[block].raw) != digest {
			return "", errors.New("DSH locator content changed")
		}
		return blocks[block].raw, nil
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", errors.New("DSH locator line not found")
}
