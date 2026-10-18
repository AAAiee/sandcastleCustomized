import type {
  WorkflowTask,
  WorkflowCheckpoint,
  WorkflowValidation,
} from "./workflow.js";

/** Complete requirements and project-owned navigation for the first implementation invocation. */
export interface WorkflowImplementationPacket {
  /** Stage policy; repair packets reference these requirements rather than repeating them. */
  readonly stage: "implement";
  /** Exact task and complete acceptance criteria. */
  readonly task: WorkflowTask;
  /** Full implementation scope, excluding the separately supplied acceptance criteria. */
  readonly scope: string;
  /** Relevant source entrypoints; the full checkout remains available. */
  readonly entrypoints: readonly string[];
  /** Project-supplied build, test and diagnostic commands. */
  readonly commands: readonly string[];
  /** Accessible project documentation and detailed evidence locations. */
  readonly references: readonly string[];
  /** Task checkout to preserve while committing the implementation. */
  readonly branch: string;
}

/** Repair only the failed behavior; complete original requirements stay available by reference. */
export interface WorkflowRepairPacket {
  /** Implementation repair, distinct from independent review format correction. */
  readonly stage: "repair";
  /** Task identity; criteria are read from the complete requirements document. */
  readonly task: WorkflowTask;
  /** Accessible copy of the complete original implementation packet. */
  readonly requirements: string;
  /** Current failure only, never a collection of historical reports. */
  readonly repair: NonNullable<WorkflowCheckpoint["repair"]>;
  /** Accessible raw evidence for the failed invocation. */
  readonly references: readonly string[];
}

/** Independent review navigation plus complete criteria and the current host evidence. */
export interface WorkflowReviewPacket {
  /** Independent semantic review, never implementation repair. */
  readonly stage: "review";
  /** Exact task and every acceptance criterion. */
  readonly task: WorkflowTask;
  /** Immutable comparison base chosen by the project. */
  readonly base: string;
  /** Immutable candidate covered by both host evidence and requested review. */
  readonly candidate: string;
  /** Complete changed-path list; no path or criterion count truncation. */
  readonly changedPaths: readonly string[];
  /** Project-owned command exposing the entire diff on demand. */
  readonly diffCommand: string;
  /** Current validation summary and exact evidence references, not raw historical reports. */
  readonly validation: WorkflowValidation;
  /** Accessible supporting documentation and current raw evidence. */
  readonly references: readonly string[];
}

/** One format-only correction. The workflow, not the packet renderer, owns its durable budget. */
export interface WorkflowCorrectionPacket {
  /** Format correction is separate from semantic repair and fresh independent review. */
  readonly stage: "correction";
  /** Task identity and criterion IDs required by the output contract. */
  readonly task: WorkflowTask;
  /** Exact immutable candidate already independently inspected. */
  readonly candidate: string;
  /** Relevant extraction or schema failure. */
  readonly problem: string;
  /** Accessible exact raw output being reformatted, without copying it into the packet. */
  readonly output: string;
}

/** Version to include in review-context identities when packet policy changes. */
export const workflowPacketPolicy = "compact-complete-stage-packets-v1";

/** Render one stateless stage packet. Inputs and output are never cached across projects. */
export function createWorkflowPacket(
  input:
    | WorkflowImplementationPacket
    | WorkflowRepairPacket
    | WorkflowReviewPacket
    | WorkflowCorrectionPacket,
): string {
  if (input.stage === "correction")
    return JSON.stringify({
      stage: input.stage,
      task: input.task.id,
      candidate: input.candidate,
      problem: input.problem,
      output: input.output,
      contract: {
        tag: "review",
        task: input.task.id,
        candidate: input.candidate,
        approved: "boolean",
        criteria: input.task.criteria.map(({ id }) => ({
          id,
          satisfied: "boolean",
          evidence: "nonempty string",
        })),
      },
      instruction:
        "Preserve the actual findings and approval/rejection decision. Reformat only; do not modify code, repeat semantic review or turn a rejection into approval. Return strict JSON in a final <review> tag on its own line, close with </review>, and no trailing text.",
    });
  if (input.stage === "review")
    return JSON.stringify({
      stage: input.stage,
      task: { id: input.task.id, criteria: input.task.criteria },
      base: input.base,
      candidate: input.candidate,
      changedPaths: input.changedPaths,
      diffCommand: input.diffCommand,
      validation: {
        candidate: input.validation.candidate,
        passed: input.validation.passed,
        identity: input.validation.identity,
        evidence: input.validation.evidence,
      },
      references: input.references,
      access:
        "Inspect the full diff, relevant source and raw evidence on demand. Judge every criterion independently.",
    });
  if (input.stage === "repair")
    return JSON.stringify({
      stage: input.stage,
      task: input.task.id,
      requirements: input.requirements,
      failedStage: input.repair.phase,
      ...(input.repair.failures?.length
        ? { failures: input.repair.failures }
        : { diagnostic: input.repair.message }),
      references: input.references,
      access:
        "Read complete requirements and exact raw evidence on demand. Repair behavior, not review formatting.",
    });
  return JSON.stringify({
    stage: input.stage,
    task: { id: input.task.id, criteria: input.task.criteria },
    scope: input.scope,
    entrypoints: input.entrypoints,
    commands: input.commands,
    references: input.references,
    branch: input.branch,
    access:
      "Read full source and referenced documents on demand; requirements are not abbreviated.",
  });
}
