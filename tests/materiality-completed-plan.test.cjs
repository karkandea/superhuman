/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assessKnowledgeMateriality,
  generateSystemInterrupt,
} = require('../.domain-test-dist/lib/ai/orchestrator.js')

test('completed plan can still receive an additive emergency interrupt without targeting history', async () => {
  const context = {
    playerId: 'p1',
    purpose: 'materiality',
    generatedAt: '2026-08-18T10:00:00Z',
    targetDate: '2026-08-18',
    playerTimezone: 'Asia/Jakarta',
    localDateTime: '2026-08-18T17:00:00',
    triggerKnowledgeEntry: { id: 'k1', type: 'life_update', text: 'Emergency baru terjadi.' },
    signals: [{ id: 's1', userId: 'p1', type: 'event', summary: 'Emergency now', importance: 5, confidence: 0.98, observedAt: '2026-08-18T10:00:00Z' }],
    recentQuestResults: [{ id: 'r1', questId: 'q-completed', outcome: 'completed', recordedAt: '2026-08-18T09:00:00Z' }],
    activeQuests: [],
    retrieval: { strategy: 'test', limit: 8, reason: 'completed plan test' },
  }

  const repository = {
    async findAssessment() { return null },
    async persistAssessment({ decision }) {
      return {
        id: 'a1', userId: 'p1', knowledgeEntryId: 'k1', targetDate: '2026-08-18',
        disposition: 'auto_interrupt', createdAt: '2026-08-18T10:00:01Z', ...decision,
      }
    },
    async findInterruptForAssessment() { return null },
    async persistInterrupt({ assessment, plan, apply }) {
      assert.equal(apply, true)
      assert.equal(plan.actions.length, 1)
      assert.equal(plan.actions[0].action, 'add')
      assert.equal(plan.actions[0].targetQuestId, undefined)
      return {
        id: 'i1', userId: 'p1', assessmentId: assessment.id, questDate: '2026-08-18',
        status: 'applied', summary: plan.summary, createdAt: '2026-08-18T10:00:02Z', appliedAt: '2026-08-18T10:00:02Z',
      }
    },
  }

  const assessed = await assessKnowledgeMateriality({
    provider: {
      id: 'test',
      async invokeStructured(request) {
        assert.equal(request.operation, 'assess_materiality')
        assert.deepEqual(request.context.activeQuests, [])
        return {
          providerId: 'test', modelId: 'test',
          output: {
            isMaterial: true,
            level: 'critical',
            confidence: 0.96,
            reason: 'A new immediate emergency requires an additional action today.',
            affectedQuestIds: [],
            sourceSignalIds: ['s1'],
            recommendedAction: 'add',
            urgency: 'immediate',
          },
        }
      },
    },
    contextRetriever: { async retrieveForMateriality() { return context } },
    repository,
  }, { playerId: 'p1', knowledgeEntryId: 'k1', date: '2026-08-18' })

  const interrupted = await generateSystemInterrupt({
    provider: {
      id: 'test',
      async invokeStructured(request) {
        assert.equal(request.operation, 'generate_system_interrupt')
        return {
          providerId: 'test', modelId: 'test',
          output: {
            summary: 'New emergency action added without rewriting completed history.',
            actions: [{
              action: 'add',
              reason: 'Immediate emergency needs action now.',
              quest: {
                title: 'Handle the emergency now',
                category: 'sepanjang_hari',
                kind: 'main',
                difficulty: 'medium',
                priority: 1,
                xp: 100,
                rationale: 'This new event is immediate and happened after the original plan was completed.',
                sourceSignalIds: ['s1'],
              },
            }],
          },
        }
      },
    },
    contextRetriever: {
      async retrieveForSystemInterrupt({ assessment }) {
        return { ...context, purpose: 'system_interrupt', materialityAssessment: assessment }
      },
    },
    repository,
  }, { playerId: 'p1', knowledgeEntryId: 'k1', date: '2026-08-18', assessment: assessed.assessment })

  assert.equal(interrupted.interrupt.status, 'applied')
})
