import { describe, expect, it } from 'vitest';
import type { Skill, SkillPlanStep } from '@flrande/bak-protocol';
import { retrieveSkills } from '../../packages/cli/src/memory/extract.js';

function createSkill(input: {
  id: string;
  domain: string;
  intent: string;
  description?: string;
  plan?: SkillPlanStep[];
  createdAt?: string;
}): Skill {
  return {
    id: input.id,
    domain: input.domain,
    intent: input.intent,
    description: input.description ?? input.intent,
    createdAt: input.createdAt ?? '2026-01-01T00:00:00.000Z',
    plan: input.plan ?? [],
    paramsSchema: { fields: {} },
    healing: { retries: 1 },
    stats: { runs: 0, success: 0, failure: 0 }
  };
}

describe('retrieveSkills ranking', () => {
  it('prioritizes structured locator anchors over generic description matches', () => {
    const skills: Skill[] = [
      createSkill({
        id: 'skill_submit_invoice',
        domain: 'app.local',
        intent: 'submit monthly invoice',
        description: 'finance workflow',
        plan: [
          {
            kind: 'click',
            locator: { role: 'button', name: 'Submit Invoice' },
            targetCandidates: [{ text: 'Submit Invoice' }, { css: '#submit-invoice' }]
          }
        ]
      }),
      createSkill({
        id: 'skill_cancel_invoice',
        domain: 'app.local',
        intent: 'submit monthly invoice',
        description: 'mentions submit invoice in docs',
        plan: [
          {
            kind: 'click',
            locator: { role: 'button', name: 'Cancel' },
            targetCandidates: [{ text: 'Cancel' }]
          }
        ]
      })
    ];

    const ranked = retrieveSkills(skills, {
      domain: 'app.local',
      intent: 'submit invoice',
      anchors: ['submit', 'invoice']
    });

    expect(ranked[0]?.id).toBe('skill_submit_invoice');
  });

  it('honors minScore threshold', () => {
    const skills: Skill[] = [
      createSkill({
        id: 'skill_a',
        domain: 'example.com',
        intent: 'open settings panel'
      })
    ];

    const ranked = retrieveSkills(skills, {
      domain: 'example.com',
      intent: 'pay invoice',
      anchors: ['payment'],
      minScore: 0.95
    });

    expect(ranked).toEqual([]);
  });

  it('remains stable with 50+ skills and keeps the most relevant skill first', () => {
    const skills: Skill[] = [];
    for (let index = 0; index < 60; index += 1) {
      skills.push(
        createSkill({
          id: `skill_noise_${index}`,
          domain: 'portal.local',
          intent: `routine task ${index}`,
          description: `noise skill ${index}`,
          plan: [
            {
              kind: 'click',
              locator: { role: 'button', name: `Action ${index}` }
            }
          ],
          createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
        })
      );
    }

    skills.push(
      createSkill({
        id: 'skill_reset_password',
        domain: 'portal.local',
        intent: 'reset account password',
        description: 'credential recovery flow',
        plan: [
          {
            kind: 'type',
            locator: { role: 'textbox', name: 'Email Address' },
            targetCandidates: [{ text: 'Forgot Password' }],
            text: '{{param_1}}'
          },
          {
            kind: 'click',
            locator: { role: 'button', name: 'Reset Password' },
            targetCandidates: [{ text: 'Send Reset Link' }]
          }
        ],
        createdAt: '2026-02-15T00:00:00.000Z'
      })
    );

    const ranked = retrieveSkills(skills, {
      domain: 'portal.local',
      intent: 'password reset for account',
      anchors: ['forgot password', 'reset link']
    });

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.id).toBe('skill_reset_password');
  });

  it('uses healing reliability as tie-breaker for similar scores', () => {
    const basePlan: SkillPlanStep[] = [
      {
        kind: 'click',
        locator: { role: 'button', name: 'Approve' },
        targetCandidates: [{ text: 'Approve' }]
      }
    ];

    const skillLow = createSkill({
      id: 'skill_low_reliability',
      domain: 'portal.local',
      intent: 'approve request',
      description: 'approve request flow',
      plan: basePlan,
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    skillLow.healing = { retries: 1, attempts: 5, successes: 1 };

    const skillHigh = createSkill({
      id: 'skill_high_reliability',
      domain: 'portal.local',
      intent: 'approve request',
      description: 'approve request flow',
      plan: basePlan,
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    skillHigh.healing = { retries: 1, attempts: 5, successes: 5 };

    const ranked = retrieveSkills([skillLow, skillHigh], {
      domain: 'portal.local',
      intent: 'approve request',
      anchors: ['approve']
    });

    expect(ranked[0]?.id).toBe('skill_high_reliability');
  });

  it('filters unrelated skills on the same domain when semantic overlap is weak', () => {
    const ranked = retrieveSkills(
      [
        createSkill({
          id: 'skill_delete_account',
          domain: 'portal.local',
          intent: 'delete account permanently',
          description: 'danger zone cleanup',
          plan: [{ kind: 'click', locator: { role: 'button', name: 'Delete Account' } }]
        })
      ],
      {
        domain: 'portal.local',
        intent: 'configure two factor authentication',
        anchors: ['security settings', '2fa']
      }
    );

    expect(ranked).toEqual([]);
  });
});


