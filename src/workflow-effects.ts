import * as filesystem from "node:fs";
import { Context, Data, Effect } from "effect";

/** Private failure channel. Public errors and abort reasons retain their identity. */
class WorkflowEffectFailure extends Data.TaggedError("WorkflowEffectFailure")<{
  readonly failure: unknown;
}> {}

// The workflow consumes callback capabilities, rather than discovering providers.
// Keep their execution in an Effect service so orchestration has one runtime and
// a typed failure channel without exposing Effect in any consumer signature.
class WorkflowEffects extends Context.Tag("WorkflowEffects")<
  WorkflowEffects,
  {
    readonly filesystem: typeof filesystem;
    readonly promise: <A>(
      action: () => PromiseLike<A> | A,
    ) => Effect.Effect<A, WorkflowEffectFailure>;
    readonly sync: <A>(
      action: () => A,
    ) => Effect.Effect<A, WorkflowEffectFailure>;
  }
>() {}
const live = {
  filesystem,
  promise: <A>(action: () => PromiseLike<A> | A) =>
    Effect.tryPromise({
      try: () => Promise.resolve().then(action),
      catch: (failure) => new WorkflowEffectFailure({ failure }),
    }),
  sync: <A>(action: () => A) =>
    Effect.try({
      try: action,
      catch: (failure) => new WorkflowEffectFailure({ failure }),
    }),
};

// Return failure as data to the *calling* generator. workflowValue throws at
// that lexical recovery point, so its try/catch/finally remains authoritative.
export const workflowStep = <A>(action: () => PromiseLike<A> | A) =>
  Effect.gen(function* () {
    const host = yield* WorkflowEffects;
    return yield* Effect.either(host.promise(action));
  });
export const workflowSync = <A>(action: () => A) =>
  Effect.gen(function* () {
    const host = yield* WorkflowEffects;
    return yield* Effect.either(host.sync(action));
  });
// Filesystem operations need Node's synchronous exclusive-open/fsync semantics
// for writer locks and durable replacement, but are still supplied by a service.
export const workflowFile = <A>(action: (fs: typeof filesystem) => A) =>
  Effect.gen(function* () {
    const host = yield* WorkflowEffects;
    return yield* Effect.either(host.sync(() => action(host.filesystem)));
  });
export function workflowValue<A>(
  result:
    | { readonly _tag: "Right"; readonly right: A }
    | { readonly _tag: "Left"; readonly left: WorkflowEffectFailure },
): A {
  if (result._tag === "Left") throw result.left.failure;
  return result.right;
}

export function workflowProgram<A, E, R>(program: Effect.Effect<A, E, R>) {
  return program.pipe(
    Effect.catchAllDefect((failure) =>
      Effect.fail(new WorkflowEffectFailure({ failure })),
    ),
  );
}

export function runWorkflowEffect<A>(
  program: Effect.Effect<A, WorkflowEffectFailure, WorkflowEffects>,
): Promise<A> {
  return program
    .pipe(
      Effect.provideService(WorkflowEffects, live),
      Effect.either,
      Effect.runPromise,
    )
    .then((result) => {
      if (result._tag === "Left") throw result.left.failure;
      return result.right;
    });
}

// Some Promise-returning handles deliberately validate synchronously before
// handing back a cached Promise. Keep that established public throw timing.
export function runWorkflowSync<A>(
  program: Effect.Effect<A, WorkflowEffectFailure, WorkflowEffects>,
): A {
  return workflowValue(
    program.pipe(
      Effect.provideService(WorkflowEffects, live),
      Effect.either,
      Effect.runSync,
    ),
  );
}
