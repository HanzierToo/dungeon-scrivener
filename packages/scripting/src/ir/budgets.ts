/** Contract limits for validating and executing one compiled script. */
export const SCRIPT_IR_LIMITS = Object.freeze({
  maxSourceBytes: 128 * 1024,
  maxSyntaxNodes: 10_000,
  maxFunctions: 256,
  maxParametersPerFunction: 32,
  maxNestingDepth: 64,
  maxInstructionsPerActivation: 50_000,
  maxLoopIterations: 1_000,
  maxHelperCallDepth: 16,
  maxCollectionMembers: 1_024,
  maxStringBytes: 16 * 1024,
  maxAllocatedBytesPerActivation: 1024 * 1024,
  maxValueDepth: 32,
  maxRequestedEffectsPerAction: 256,
} as const);
