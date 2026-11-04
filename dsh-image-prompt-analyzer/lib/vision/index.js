
export {
  VisionError,
  VISION_CODES,
  createDshRouteBackend,
  createVisionBackend,
  describeVisionBackend,
  resolveDshTarget,
  resolveVisionCandidates,
  resolveVisionTarget,
  classifyVisionFailure,
  markUnavailable,
  isUnavailable,
  resetAvailability,
  DEFAULT_UNAVAILABLE_TTL_SECONDS,
} from './backend.js'

export { analyzeVision, applyStageA, intersectionOverUnion, padBox, planLocalReviews, buildTargetedReviews, reviewBoxBudget, REVIEW_BOX_DEFAULT, REVIEW_BOX_MAX } from './analyze.js'

export {
  COVERAGE_CODES,
  collectIRFeatures,
  computeDimensionCoverage,
  coverageProblems,
} from './coverage.js'

export {
  COVERAGE_STATUS_LABELS,
  DIMENSIONS,
  DIMENSION_IDS,
  DIMENSION_STATUSES,
  animateSubjectState,
  dimensionById,
  dimensionSummaryLine,
  dimensionsForCategory,
  dimensionsForKey,
  requiredCategoryApplicable,
} from './dimensions.js'

export {
  coerceNumber,
  extractBalancedJson,
  normalizeDimensionCoverage,
  normalizeStageA,
  normalizeStageB,
  parseModelJson,
  stripCodeFences,
} from './parse.js'

export {
  ANALYSIS_CATEGORY_IDS,
  CATEGORY_INSTRUCTIONS,
  PROMPT_CONTRACT,
  STAGE_A_SYSTEM,
  STAGE_B_SYSTEM,
  buildStageAPrompt,
  buildStageBPrompt,
} from './prompt.js'
