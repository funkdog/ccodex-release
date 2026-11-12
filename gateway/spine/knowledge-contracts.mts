export interface KnowledgeSource { kind: "thread" | "radar" | "git" | "web"; uri: string; engine?: string }
export interface MycodexKnowledgeCard {
  schemaVersion: 1; id: string; revision: number; date: string; title: string; body: string; tags: string[];
  sources: KnowledgeSource[]; status: "candidate" | "reviewed"; createdAt: number; updatedAt: number; createdBy: "mycodex";
}
