package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"gopkg.in/yaml.v3"
)

const projectMetadataRelativePath = ".pi/project.yaml"

type projectMetadataManifest struct {
	ID                string `yaml:"id"`
	Name              string `yaml:"name"`
	DefaultBaseBranch string `yaml:"defaultBaseBranch"`
	ToolingFile       string `yaml:"toolingFile"`
	NotesFile         string `yaml:"notesFile"`
	Active            *bool  `yaml:"active"`
}

// ReadProjectMetadata imports repo-local metadata with explicit fallback
// statuses so callers can degrade cleanly when the manifest is missing or bad.
func ReadProjectMetadata(repoPath string) (models.ProjectMetadataImport, error) {
	repoPath = strings.TrimSpace(repoPath)
	if repoPath == "" {
		return models.ProjectMetadataImport{}, errors.New("repoPath is required")
	}

	absRepoPath, err := filepath.Abs(repoPath)
	if err != nil {
		return models.ProjectMetadataImport{}, fmt.Errorf("resolve repoPath: %w", err)
	}

	result := models.ProjectMetadataImport{
		RepoPath:     absRepoPath,
		MetadataFile: filepath.Join(absRepoPath, projectMetadataRelativePath),
	}

	data, err := os.ReadFile(result.MetadataFile)
	switch {
	case errors.Is(err, os.ErrNotExist):
		result.Status = models.ProjectMetadataImportStatusMissing
		return result, nil
	case err != nil:
		result.Status = models.ProjectMetadataImportStatusInvalid
		result.Error = fmt.Sprintf("read metadata file: %v", err)
		return result, nil
	}

	var manifest projectMetadataManifest
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&manifest); err != nil {
		result.Status = models.ProjectMetadataImportStatusInvalid
		result.Error = fmt.Sprintf("decode metadata file: %v", err)
		return result, nil
	}

	metadata := models.ProjectMetadata{
		ID:                strings.TrimSpace(manifest.ID),
		Name:              strings.TrimSpace(manifest.Name),
		DefaultBaseBranch: strings.TrimSpace(manifest.DefaultBaseBranch),
		RepoPath:          absRepoPath,
		MetadataFile:      result.MetadataFile,
		Active:            true,
	}
	if manifest.Active != nil {
		metadata.Active = *manifest.Active
	}

	warnings := make([]string, 0, 2)
	if toolingFile, warning := resolveOptionalCompanionFile(absRepoPath, manifest.ToolingFile, "toolingFile"); toolingFile != "" {
		metadata.ToolingFile = toolingFile
	} else if warning != "" {
		warnings = append(warnings, warning)
	}
	if notesFile, warning := resolveOptionalCompanionFile(absRepoPath, manifest.NotesFile, "notesFile"); notesFile != "" {
		metadata.NotesFile = notesFile
	} else if warning != "" {
		warnings = append(warnings, warning)
	}

	result.Metadata = &metadata
	result.Warnings = warnings
	if len(warnings) > 0 {
		result.Status = models.ProjectMetadataImportStatusLoadedWithWarnings
	} else {
		result.Status = models.ProjectMetadataImportStatusLoaded
	}
	if err := result.Validate(); err != nil {
		return models.ProjectMetadataImport{}, fmt.Errorf("validate project metadata import: %w", err)
	}
	return result, nil
}

func resolveOptionalCompanionFile(repoPath, rawPath, field string) (string, string) {
	trimmed := strings.TrimSpace(rawPath)
	if trimmed == "" {
		return "", ""
	}

	resolved := trimmed
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(repoPath, ".pi", trimmed)
	}
	resolved = filepath.Clean(resolved)

	info, err := os.Stat(resolved)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "", fmt.Sprintf("%s %q is referenced by %s but the file does not exist", field, trimmed, projectMetadataRelativePath)
	case err != nil:
		return "", fmt.Sprintf("%s %q is referenced by %s but could not be inspected: %v", field, trimmed, projectMetadataRelativePath, err)
	case info.IsDir():
		return "", fmt.Sprintf("%s %q is referenced by %s but resolves to a directory", field, trimmed, projectMetadataRelativePath)
	default:
		return resolved, ""
	}
}
