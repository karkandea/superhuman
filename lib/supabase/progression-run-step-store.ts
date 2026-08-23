import type { SupabaseClient } from '@supabase/supabase-js'

export type ProgressionStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked'

export interface ProgressionRunStepInput {
  jobId: string
  workerId: string
  step: string
  inputHash?: string
  schemaVersion?: string
}

export interface ProgressionRunStepCompletion extends ProgressionRunStepInput {
  status: Exclude<ProgressionStepStatus, 'pending' | 'running'>
  artifactType?: string
  artifactId?: string
  providerId?: string
  modelId?: string
  requestId?: string
  repairAttemptCount?: number
  errorClass?: string
  errorCode?: string
  validatorCode?: string
  errorMessage?: string
}

export interface ProgressionRunStepStore {
  start(input: ProgressionRunStepInput): Promise<void>
  complete(input: ProgressionRunStepCompletion): Promise<void>
}

export function createSupabaseProgressionRunStepStore(client: SupabaseClient): ProgressionRunStepStore {
  return {
    async start(input) {
      const { error } = await client.rpc('start_progression_run_step', {
        p_job_id: input.jobId,
        p_worker_id: input.workerId,
        p_step: input.step,
        p_input_hash: input.inputHash ?? null,
        p_schema_version: input.schemaVersion ?? null,
      })
      if (error) throw new Error(`start progression step ${input.step}: ${error.message}`)
    },

    async complete(input) {
      const { error } = await client.rpc('complete_progression_run_step', {
        p_job_id: input.jobId,
        p_worker_id: input.workerId,
        p_step: input.step,
        p_status: input.status,
        p_artifact_type: input.artifactType ?? null,
        p_artifact_id: input.artifactId ?? null,
        p_provider_id: input.providerId ?? null,
        p_model_id: input.modelId ?? null,
        p_request_id: input.requestId ?? null,
        p_repair_attempt_count: input.repairAttemptCount ?? 0,
        p_error_class: input.errorClass ?? null,
        p_error_code: input.errorCode ?? null,
        p_validator_code: input.validatorCode ?? null,
        p_error_message: input.errorMessage ?? null,
      })
      if (error) throw new Error(`complete progression step ${input.step}: ${error.message}`)
    },
  }
}
