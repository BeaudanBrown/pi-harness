package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
)

// Store handles manifest and runtime persistence beneath the harness XDG roots.
type Store struct {
	Roots paths.Roots
}

// New returns a store bound to the harness directory roots.
func New(roots paths.Roots) Store {
	return Store{Roots: roots}
}

func (s Store) WriteManifest(record models.WorkstreamRecord) error {
	if err := record.Validate(); err != nil {
		return fmt.Errorf("validate manifest: %w", err)
	}
	return writeJSONAtomically(s.Roots.ManifestPath(record.WorkstreamID), record)
}

func (s Store) ReadManifest(workstreamID string) (models.WorkstreamRecord, error) {
	var record models.WorkstreamRecord
	if err := readJSON(s.Roots.ManifestPath(workstreamID), &record); err != nil {
		return models.WorkstreamRecord{}, err
	}
	if err := record.Validate(); err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("validate manifest: %w", err)
	}
	return record, nil
}

func (s Store) UpdateManifest(workstreamID string, mutate func(*models.WorkstreamRecord) error) (models.WorkstreamRecord, error) {
	if mutate == nil {
		return models.WorkstreamRecord{}, errors.New("mutate function is required")
	}

	record, err := s.ReadManifest(workstreamID)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	record.Contexts = append([]models.WorkstreamContext(nil), record.Contexts...)
	if err := mutate(&record); err != nil {
		return models.WorkstreamRecord{}, err
	}
	if err := record.Validate(); err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("validate manifest: %w", err)
	}
	if err := writeJSONAtomically(s.Roots.ManifestPath(workstreamID), record); err != nil {
		return models.WorkstreamRecord{}, err
	}
	return record, nil
}

func (s Store) WriteRuntime(status models.RuntimeStatus) error {
	if err := status.Validate(); err != nil {
		return fmt.Errorf("validate runtime: %w", err)
	}
	return writeJSONAtomically(s.Roots.RuntimePath(status.WorkstreamID), status)
}

func (s Store) ReadRuntime(workstreamID string) (models.RuntimeStatus, error) {
	var status models.RuntimeStatus
	if err := readJSON(s.Roots.RuntimePath(workstreamID), &status); err != nil {
		return models.RuntimeStatus{}, err
	}
	if err := status.Validate(); err != nil {
		return models.RuntimeStatus{}, fmt.Errorf("validate runtime: %w", err)
	}
	return status, nil
}

func (s Store) ListWorkstreamIDs() ([]string, error) {
	entries, err := os.ReadDir(s.Roots.Workstreams)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read workstreams dir: %w", err)
	}

	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if filepath.Ext(name) != ".json" {
			continue
		}
		ids = append(ids, name[:len(name)-len(".json")])
	}
	sort.Strings(ids)
	return ids, nil
}

func writeJSONAtomically(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create parent dir: %w", err)
	}

	tempFile, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	encoder := json.NewEncoder(tempFile)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		tempFile.Close()
		return fmt.Errorf("encode json: %w", err)
	}
	if err := tempFile.Sync(); err != nil {
		tempFile.Close()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("rename temp file: %w", err)
	}
	if err := syncDir(filepath.Dir(path)); err != nil {
		return err
	}
	return nil
}

func readJSON(path string, dest any) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("decode %s: trailing data", path)
	}
	return nil
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open dir %s: %w", path, err)
	}
	defer dir.Close()

	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync dir %s: %w", path, err)
	}
	return nil
}
