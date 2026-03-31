package contexts

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/beaudanbrown/pi-harness/internal/models"
	"github.com/beaudanbrown/pi-harness/internal/paths"
	"github.com/beaudanbrown/pi-harness/internal/store"
)

var errNotGitRepository = errors.New("path is not inside a git repository")

type gitRunner interface {
	Output(ctx context.Context, dir string, args ...string) (string, error)
	Run(ctx context.Context, dir string, args ...string) error
}

type execGitRunner struct{}

func (execGitRunner) Output(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(exitErr.Stderr)), err)
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output)), nil
}

func (execGitRunner) Run(ctx context.Context, dir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(output)), err)
	}
	return nil
}

// Attacher provisions durable workstream attachments.
type Attacher struct {
	Roots             paths.Roots
	Store             store.Store
	Manager           Manager
	Git               gitRunner
	ShareRegistryPath string
}

type AttachGitWorktreeInput struct {
	ContextID   string
	ProjectID   string
	DisplayName string
	Path        string
	Mode        string
	Role        string
}

type AttachPathInput struct {
	ContextID   string
	ProjectID   string
	DisplayName string
	Path        string
	Mode        string
	Role        string
}

func NewAttacher(roots paths.Roots, s store.Store, now func() time.Time) Attacher {
	return Attacher{
		Roots:             roots,
		Store:             s,
		Manager:           New(s, now),
		Git:               execGitRunner{},
		ShareRegistryPath: paths.ShareRegistryPath(),
	}
}

type ShareAttachmentCandidate struct {
	DisplayName       string
	Detail            string
	Path              string
	ProjectID         string
	DefaultBaseBranch string
	ToolingFile       string
	NotesFile         string
	Share             models.SharedProject
	MetadataImport    *models.ProjectMetadataImport
}

func (a Attacher) ShareAttachmentCandidates() ([]ShareAttachmentCandidate, error) {
	projects, err := store.ReadShareRegistry(a.ShareRegistryPath)
	if err != nil {
		return nil, err
	}

	candidates := make([]ShareAttachmentCandidate, 0, len(projects))
	for _, project := range projects {
		imported, err := store.ReadProjectMetadata(project.GuestPath)
		if err != nil {
			return nil, fmt.Errorf("read project metadata for %q: %w", project.GuestPath, err)
		}

		displayName := project.AgentPath
		projectID := ""
		defaultBaseBranch := ""
		toolingFile := ""
		notesFile := ""
		if metadata := activeCandidateMetadata(imported); metadata != nil {
			projectID = metadata.ID
			defaultBaseBranch = metadata.DefaultBaseBranch
			toolingFile = metadata.ToolingFile
			notesFile = metadata.NotesFile
			if label := strings.TrimSpace(metadata.Name); label != "" {
				displayName = label
			}
		}

		importedCopy := imported
		candidates = append(candidates, ShareAttachmentCandidate{
			DisplayName:       displayName,
			Detail:            shareAttachmentCandidateDetail(displayName, project, importedCopy),
			Path:              project.GuestPath,
			ProjectID:         projectID,
			DefaultBaseBranch: defaultBaseBranch,
			ToolingFile:       toolingFile,
			NotesFile:         notesFile,
			Share:             project,
			MetadataImport:    &importedCopy,
		})
	}
	return candidates, nil
}

func activeCandidateMetadata(imported models.ProjectMetadataImport) *models.ProjectMetadata {
	if imported.Status != models.ProjectMetadataImportStatusLoaded &&
		imported.Status != models.ProjectMetadataImportStatusLoadedWithWarnings {
		return nil
	}
	if imported.Metadata == nil || !imported.Metadata.Active {
		return nil
	}
	return imported.Metadata
}

func shareAttachmentCandidateDetail(displayName string, project models.SharedProject, imported models.ProjectMetadataImport) string {
	details := make([]string, 0, 4)
	if shareLabel := strings.TrimSpace(project.AgentPath); shareLabel != "" && shareLabel != displayName {
		details = append(details, shareLabel)
	}
	if metadata := activeCandidateMetadata(imported); metadata != nil {
		if branch := strings.TrimSpace(metadata.DefaultBaseBranch); branch != "" {
			details = append(details, "base "+branch)
		}
		if metadata.ToolingFile != "" {
			details = append(details, "tooling")
		}
		if metadata.NotesFile != "" {
			details = append(details, "notes")
		}
	}
	return strings.Join(details, " | ")
}

func (a Attacher) Attach(ctx context.Context, workstreamID string, input AttachPathInput) (models.WorkstreamRecord, error) {
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = models.ContextModeIsolated
	}

	sourcePath, err := filepath.Abs(strings.TrimSpace(input.Path))
	if err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("resolve source path: %w", err)
	}

	repoRoot, err := a.gitTopLevel(ctx, sourcePath)
	switch {
	case err == nil && repoRoot == sourcePath && mode == models.ContextModeIsolated:
		return a.AttachGitWorktree(ctx, workstreamID, AttachGitWorktreeInput{
			ContextID:   input.ContextID,
			ProjectID:   input.ProjectID,
			DisplayName: input.DisplayName,
			Path:        sourcePath,
			Mode:        mode,
			Role:        input.Role,
		})
	case err == nil && repoRoot == sourcePath:
		input.Path = sourcePath
		input.Mode = mode
		return a.AttachPath(ctx, workstreamID, input)
	case err == nil:
		input.Path = sourcePath
		input.Mode = mode
		return a.AttachPath(ctx, workstreamID, input)
	case errors.Is(err, errNotGitRepository):
		input.Path = sourcePath
		input.Mode = mode
		return a.AttachPath(ctx, workstreamID, input)
	default:
		return models.WorkstreamRecord{}, err
	}
}

func (a Attacher) AttachGitWorktree(ctx context.Context, workstreamID string, input AttachGitWorktreeInput) (models.WorkstreamRecord, error) {
	if strings.TrimSpace(workstreamID) == "" {
		return models.WorkstreamRecord{}, errors.New("workstream is required")
	}
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = models.ContextModeIsolated
	}
	if mode != models.ContextModeIsolated {
		return models.WorkstreamRecord{}, fmt.Errorf("isolated worktree attach only supports mode %q", models.ContextModeIsolated)
	}
	sourcePath, err := filepath.Abs(strings.TrimSpace(input.Path))
	if err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("resolve source path: %w", err)
	}

	record, err := a.Store.ReadManifest(workstreamID)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	repoRoot, err := a.gitTopLevel(ctx, sourcePath)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	displayName := strings.TrimSpace(input.DisplayName)
	contextName := displayName
	if contextName == "" {
		contextName = filepath.Base(repoRoot)
	}

	contextID, err := chooseContextID(strings.TrimSpace(input.ContextID), contextName, record.Contexts)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	role := strings.TrimSpace(input.Role)
	if role == "" {
		role = defaultRole(record)
	}

	targetPath := a.Roots.WorktreePath(workstreamID, contextID)
	if _, err := os.Stat(targetPath); err == nil {
		return models.WorkstreamRecord{}, fmt.Errorf("target worktree path %q already exists", targetPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return models.WorkstreamRecord{}, fmt.Errorf("check target worktree path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("create worktree parent dir: %w", err)
	}

	branch, err := a.uniqueBranchName(ctx, repoRoot, workstreamID, contextID)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	if err := a.Git.Run(ctx, repoRoot, "worktree", "add", "-b", branch, targetPath, "HEAD"); err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("create isolated worktree: %w", err)
	}

	attached := false
	defer func() {
		if attached {
			return
		}
		_ = a.Git.Run(context.Background(), repoRoot, "worktree", "remove", "--force", targetPath)
		_ = a.Git.Run(context.Background(), repoRoot, "branch", "-D", branch)
	}()

	record, err = a.Manager.AddContext(workstreamID, AddInput{
		ContextID:         contextID,
		ProjectID:         strings.TrimSpace(input.ProjectID),
		DisplayName:       displayName,
		Path:              targetPath,
		Kind:              models.ContextKindWorktree,
		Mode:              mode,
		Role:              role,
		Branch:            branch,
		OwnerWorkstreamID: workstreamID,
	})
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	attached = true
	return record, nil
}

func (a Attacher) AttachPath(ctx context.Context, workstreamID string, input AttachPathInput) (models.WorkstreamRecord, error) {
	if strings.TrimSpace(workstreamID) == "" {
		return models.WorkstreamRecord{}, errors.New("workstream is required")
	}

	sourcePath, err := filepath.Abs(strings.TrimSpace(input.Path))
	if err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("resolve source path: %w", err)
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		return models.WorkstreamRecord{}, fmt.Errorf("stat path: %w", err)
	}
	if !info.IsDir() {
		return models.WorkstreamRecord{}, fmt.Errorf("path %q must be a directory", sourcePath)
	}

	record, err := a.Store.ReadManifest(workstreamID)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	displayName := strings.TrimSpace(input.DisplayName)
	contextName := displayName
	if contextName == "" {
		contextName = filepath.Base(sourcePath)
	}

	contextID, err := chooseContextID(strings.TrimSpace(input.ContextID), contextName, record.Contexts)
	if err != nil {
		return models.WorkstreamRecord{}, err
	}

	role := strings.TrimSpace(input.Role)
	if role == "" {
		role = defaultRole(record)
	}

	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = models.ContextModeIsolated
	}

	kind := models.ContextKindDirectory
	if repoRoot, err := a.gitTopLevel(ctx, sourcePath); err == nil {
		if repoRoot == sourcePath {
			kind = models.ContextKindCheckout
		}
	} else if !errors.Is(err, errNotGitRepository) {
		return models.WorkstreamRecord{}, err
	}

	return a.Manager.AddContext(workstreamID, AddInput{
		ContextID:   contextID,
		ProjectID:   strings.TrimSpace(input.ProjectID),
		DisplayName: displayName,
		Path:        sourcePath,
		Kind:        kind,
		Mode:        mode,
		Role:        role,
	})
}

func (a Attacher) gitTopLevel(ctx context.Context, path string) (string, error) {
	root, err := a.Git.Output(ctx, path, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", errNotGitRepository
	}
	return filepath.Clean(root), nil
}

func (a Attacher) uniqueBranchName(ctx context.Context, repoRoot, workstreamID, contextID string) (string, error) {
	base := sanitizeBranchComponent(workstreamID) + "/" + sanitizeBranchComponent(contextID)
	if base == "/" {
		base = "workstream/context"
	}

	candidate := "ph/" + base
	if exists, err := a.branchExists(ctx, repoRoot, candidate); err != nil {
		return "", err
	} else if !exists {
		return candidate, nil
	}

	for suffix := 2; ; suffix++ {
		candidate = fmt.Sprintf("ph/%s-%d", base, suffix)
		exists, err := a.branchExists(ctx, repoRoot, candidate)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
}

func (a Attacher) branchExists(ctx context.Context, repoRoot, branch string) (bool, error) {
	_, err := a.Git.Output(ctx, repoRoot, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("check branch %q: %w", branch, err)
}

func defaultRole(record models.WorkstreamRecord) string {
	if record.PrimaryContextID == "" {
		return models.ContextRolePrimary
	}
	return models.ContextRoleSecondary
}

func chooseContextID(explicit, displayName string, existing []models.WorkstreamContext) (string, error) {
	if explicit != "" {
		for _, context := range existing {
			if context.ContextID == explicit {
				return "", fmt.Errorf("contextId %q is duplicated", explicit)
			}
		}
		return explicit, nil
	}

	seen := make(map[string]struct{}, len(existing))
	for _, context := range existing {
		seen[context.ContextID] = struct{}{}
	}

	base := slugify(displayName)
	if base == "" {
		base = "context"
	}
	if _, exists := seen[base]; !exists {
		return base, nil
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", base, suffix)
		if _, exists := seen[candidate]; !exists {
			return candidate, nil
		}
	}
}

func slugify(value string) string {
	var b strings.Builder
	lastHyphen := true
	for _, r := range strings.ToLower(value) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func sanitizeBranchComponent(value string) string {
	replacer := strings.NewReplacer(" ", "-", "~", "-", "^", "-", ":", "-", "?", "-", "*", "-", "[", "-", "\\", "-", "..", "-", "@{", "-")
	value = replacer.Replace(strings.TrimSpace(value))
	value = strings.Trim(value, "/.-")
	value = strings.ReplaceAll(value, "//", "/")
	if value == "" {
		return "context"
	}
	return value
}
