package models

const CurrentSchemaVersion = 1

// WorkstreamContext is the durable attachment record for one workstream path.
type WorkstreamContext struct {
	ContextID         string `json:"contextId"`
	ProjectID         string `json:"projectId,omitempty"`
	DisplayName       string `json:"displayName"`
	Path              string `json:"path"`
	Kind              string `json:"kind"`
	Mode              string `json:"mode"`
	Role              string `json:"role"`
	Branch            string `json:"branch,omitempty"`
	OwnerWorkstreamID string `json:"ownerWorkstreamId,omitempty"`
}

// WorkstreamRecord is the durable manifest shape for a workstream.
type WorkstreamRecord struct {
	SchemaVersion    int                 `json:"schemaVersion"`
	WorkstreamID     string              `json:"workstreamId"`
	Title            string              `json:"title"`
	TmuxSession      string              `json:"tmuxSession"`
	CreatedAt        string              `json:"createdAt"`
	UpdatedAt        string              `json:"updatedAt"`
	PrimaryContextID string              `json:"primaryContextId,omitempty"`
	Contexts         []WorkstreamContext `json:"contexts"`
	Notes            string              `json:"notes"`
}

// RuntimeStatus is the live state contract merged with tmux discovery.
type RuntimeStatus struct {
	SchemaVersion    int    `json:"schemaVersion"`
	WorkstreamID     string `json:"workstreamId"`
	TmuxSession      string `json:"tmuxSession"`
	State            string `json:"state"`
	CWD              string `json:"cwd"`
	LastSeenAt       string `json:"lastSeenAt"`
	LastProcessingAt string `json:"lastProcessingAt,omitempty"`
	ActiveModel      string `json:"activeModel,omitempty"`
}
