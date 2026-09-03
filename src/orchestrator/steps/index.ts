import type { StepType } from '../../domain/enums.js'
import { approvalStep } from './approval.step.js'
import { contentGenerateStep } from './contentGenerate.step.js'
import { contentValidateStep } from './contentValidate.step.js'
import { icpSynthesisStep } from './icpSynthesis.step.js'
import { intakeStep } from './intake.step.js'
import { packageStep } from './package.step.js'
import { researchStep } from './research.step.js'
import { segmentProposeStep } from './segmentPropose.step.js'
import { segmentResolveStep } from './segmentResolve.step.js'
import { strategyStep } from './strategy.step.js'
import type { StepHandler } from './types.js'

// Step type -> handler. The state machine decides the order; this only maps
// names to code, so an unmapped step is a startup-visible gap rather than a
// silent no-op mid-run.

export const STEP_HANDLERS: Record<StepType, StepHandler> = {
  INTAKE: intakeStep,
  ICP_SYNTHESIS: icpSynthesisStep,
  SEGMENT_PROPOSE: segmentProposeStep,
  SEGMENT_RESOLVE: segmentResolveStep,
  RESEARCH: researchStep,
  STRATEGY: strategyStep,
  APPROVAL_STRATEGY: approvalStep('strategy'),
  CONTENT_GENERATE: contentGenerateStep,
  CONTENT_VALIDATE: contentValidateStep,
  APPROVAL_CONTENT: approvalStep('content'),
  PACKAGE: packageStep,
}

export type { StepHandler, StepContext, StepResult } from './types.js'
