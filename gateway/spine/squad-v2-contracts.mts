/**
 * Squad V2 shared type contracts between the Gateway kernel, MCP surface,
 * inline milestone cards, and the native split-pane Squad Studio view.
 * Pure TypeScript interfaces/types only: zero Node or DOM runtime imports.
 */
import type { HostThreadRef } from "./host-thread-contracts.mjs";

export type SquadSlotContinuity = "stateful" | "clean";
export type SquadSlotWorkspace = "shared" | "worktree" | "scratch";
export type SquadSlotActivity = "planned" | "active" | "waiting" | "quiescent" | "failed" | "offline" | "closed";
export type SquadSlotStage = "planned" | "running" | "waiting" | "delivered" | "blocked" | "escalated" | "accepted" | "superseded" | "failed" | "offline";
export interface SquadRepoBinding {
  /** Local repository/bare-repo path or remote Git URL (http/https/ssh). */
  source: string;
  /** Optional base branch, tag or commit (defaults to HEAD / remote default branch). */
  baseRef?: string;
  /** Optional checkout branch name (defaults to role/<squadId>/<slotId>). */
  branch?: string;
  /** Optional submodule initialization when creating the worktree. */
  submodules?: boolean;
}
export interface SquadIntegrationTree {
  repoKey: string;
  source: string;
  branch: string;
  worktreePath: string;
}
export interface SquadBriefOptions {
  criteriaIds?: string[];
  inputs?: string[];
  forbid?: string[];
  readOnly?: boolean;
  repo?: SquadRepoBinding | null;
  peerWorktrees?: Array<{ slotId: string; handle: string; path: string; branch?: string | null; repoSource?: string | null }>;
  incrementalFromRevision?: number | null;
  checkScriptPath?: string | null;
  promptOnly?: boolean;
}
export interface SquadDeliverable {
  kind: "mr" | "issue" | "commit" | "branch" | "report" | "artifact";
  label: string;
  target?: string;
  detail?: string;
  /** Resolved http(s) remote link when verified/safe (never guessed for unpushed commits). */
  href?: string;
  /** In-Studio read-only preview capability for local commits or whitelisted text/markdown artifacts. */
  previewKind?: "commit" | "markdown" | "text";
  /** Slot-scoped identifier passed back to `/artifact` for safe server-side resolution. */
  previewRef?: string;
}
export interface SquadArtifactPreview {
  kind: "commit" | "markdown" | "text";
  title: string;
  subtitle?: string;
  content: string;
  truncated?: boolean;
}
export interface SquadDeltaSummary {
  baseSha: string | null;
  headSha: string | null;
  commitCount: number;
  changedCount: number;
  dirtyCount?: number;
  files: SquadWorkspaceDelta["changed"];
  outsideTouches: string[];
  forbidViolations?: string[];
}
export interface SquadSlotRound {
  round: number;
  goal: string;
  criteriaIds?: string[];
  touches: string[];
  forbid?: string[];
  readOnly?: boolean;
  inputs?: string[];
  repo?: SquadRepoBinding;
  stateRevisionSent?: number;
  dispatchedAt: number;
  completedAt?: number;
  acceptedAt?: number;
  stage: SquadSlotStage;
  result?: SquadSlotResult;
  briefMarkdown?: string;
  deliverables: SquadDeliverable[];
  deltaSummary?: SquadDeltaSummary;
}
export type SquadSelfReportStatus = "done" | "blocked" | "escalate";

export interface SquadCriterion {
  id: string;
  text: string;
  detail?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: number | null;
}

export interface SquadChoiceOption {
  id: string;
  label: string;
  summary: string;
}

export interface SquadGate {
  id: string;
  kind: "blueprint" | "decision" | "convergence";
  title: string;
  question: string;
  recommendedOptionId?: string | null;
  options?: SquadChoiceOption[];
  status: "open" | "approved" | "changes_requested";
  resolutionText?: string | null;
  openedAt: number;
  resolvedAt?: number | null;
  stateRevision: number;
}

export interface SquadTaskNode {
  slotId: string;
  goal: string;
  touches: string[];
  dependsOn: string[];
  status: "todo" | "running" | "review" | "done" | "blocked";
}

export interface SquadStateRecord {
  schemaVersion: 2;
  squadId: string;
  revision: number;
  title: string;
  intent: string;
  invariants: string[];
  contracts: string[];
  criteria: SquadCriterion[];
  tasks: SquadTaskNode[];
  openBlockers: Array<{ id: string; slotId?: string | null; summary: string; createdAt: number }>;
  activeGate?: SquadGate | null;
  updatedAt: number;
}

export interface SquadWorkspaceDelta {
  baseSha: string | null;
  headSha: string | null;
  dirtyCount?: number;
  commits: Array<{ sha: string; subject: string }>;
  changed: Array<{ path: string; status: "A" | "M" | "D"; add: number; del: number }>;
  outsideTouches: string[];
  forbidViolations?: string[];
}

export interface SquadSlotResult {
  status: SquadSelfReportStatus;
  summary: string;
  assumptions: string[];
  body: string;
  deliverables?: SquadDeliverable[];
  criteriaMet?: string[];
  reportedAt: number;
  autoSynthesized?: boolean;
}

export interface SquadSlotRecord {
  slotId: string;
  rounds?: SquadSlotRound[];
  handle: string;
  continuity: SquadSlotContinuity;
  workspace: SquadSlotWorkspace;
  engine: string;
  model: string;
  reasoningEffort?: string | null;
  threadId?: string | null;
  hostRef?: HostThreadRef | null;
  repo?: SquadRepoBinding | null;
  repoKey?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseSha?: string | null;
  touches: string[];
  forbid?: string[];
  readOnly?: boolean;
  dependsOn: string[];
  sidebarHidden: boolean;
  retired?: boolean;
  supersededBy?: string | null;
  dispatchedAt?: number | null;
  updatedAt: number;
}

export interface SquadSlotLiveView extends SquadSlotRecord {
  stage?: SquadSlotStage;
  deliverables?: SquadDeliverable[];
  activity: SquadSlotActivity;
  waitsOn?: string | null;
  elapsedMs?: number | null;
  contextPercent?: number | null;
  briefMarkdown?: string | null;
  result?: SquadSlotResult | null;
  delta?: SquadWorkspaceDelta | null;
  lastOutputSnippet?: string | null;
}

export interface SquadEventRecord {
  seq: number;
  at: number;
  kind:
    | "initialized"
    | "state_updated"
    | "gate_opened"
    | "gate_resolved"
    | "dispatched"
    | "quiescent"
    | "waiting"
    | "human_stepped_in"
    | "integrated"
    | "promoted"
    | "closed";
  slotId?: string | null;
  summary: string;
}

export interface SquadQuiescenceSnapshot {
  squadId: string;
  slotId: string;
  rounds?: SquadSlotRound[];
  handle: string;
  activity: "quiescent" | "waiting" | "failed";
  turnStatus?: "completed" | "failed" | "interrupted";
  waitsOn?: string | null;
  selfReport?: SquadSlotResult | null;
  delta?: SquadWorkspaceDelta | null;
  lastMessage?: string | null;
  observedAt: number;
}

/** Observed session metadata; never persisted as a slot's dispatch contract. */
export interface SquadSessionSettings {
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface SquadStudioSnapshot {
  squadId: string;
  anchorThreadId: string;
  anchorHostRef?: HostThreadRef | null;
  anchorSettings?: SquadSessionSettings;
  integrationBranch?: string | null;
  integrationWorktree?: string | null;
  integrations?: Record<string, SquadIntegrationTree>;
  status: "active" | "closed";
  studioUrl?: string | null;
  state: SquadStateRecord;
  slots: SquadSlotLiveView[];
  needsYou: Array<{
    kind: "gate" | "slot_waiting" | "slot_failed" | "slot_escalated";
    slotId?: string | null;
    title: string;
    detail: string;
  }>;
  events: SquadEventRecord[];
}


/** Per-presentation editorial content; never part of the single-writer STATE. */
export interface SquadCardReview {
  summary?: string;
  highlights?: Array<{ title: string; body: string; kind?: "tradeoff" | "architecture" | "performance" | "risk" }>;
}
