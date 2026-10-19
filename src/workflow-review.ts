import { coversCriteria } from "./workflow-criteria.js";
import {
  WorkflowOperationError,
  type WorkflowReview,
  type WorkflowTask,
} from "./workflow.js";

/** Strict JSON only. A final malformed representation never falls back to an older approval. */
export function extractWorkflowReview(
  output: unknown,
  context: { task: WorkflowTask; candidate: string },
): WorkflowReview & { task: string } {
  const invalid = (message: string): never => {
    throw new WorkflowOperationError("format", message);
  };
  let value: unknown = output;
  if (typeof output === "string") {
    let raw = output.trim();
    const tag = [...raw.matchAll(/(?:^|\n)[ \t]*<review>/g)].at(-1);
    const opening = tag ? tag.index! + tag[0].length - 8 : -1;
    if (opening !== -1) {
      const closing = raw.lastIndexOf("</review>");
      if (closing === -1 || raw.slice(closing + 9).trim())
        invalid("The final <review> must be complete and end the output.");
      raw = raw.slice(opening + 8, closing).trim();
    }
    if (/^```/m.test(raw)) {
      const fences = [
        ...raw.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/gm),
      ];
      const fence = fences.at(-1);
      if (!fence || raw.slice(fence.index! + fence[0].length).trim())
        invalid("The final JSON fence is incomplete or ambiguous.");
      raw = fence![1]!.trim();
    }
    try {
      value = JSON.parse(raw);
    } catch {
      invalid(
        "Review output is not strict JSON in a final <review>, fence, or complete object.",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Review must be an object.");
  const review = value as WorkflowReview & { task: string };
  const entries = review.criteria;
  if (
    review.task !== context.task.id ||
    review.candidate !== context.candidate ||
    typeof review.approved !== "boolean" ||
    !Array.isArray(entries) ||
    !entries.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.satisfied === "boolean" &&
        typeof entry.evidence === "string" &&
        entry.evidence.trim(),
    ) ||
    !coversCriteria(context.task.criteria, entries)
  )
    invalid(
      "Review must identify this exact task/candidate and every criterion exactly once with evidence.",
    );
  return structuredClone(review);
}
