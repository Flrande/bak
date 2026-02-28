import type { ElementMapItem, Episode, Locator, Skill, SkillPlanStep } from '@bak/protocol';
import { getDomain } from '../utils.js';

export function buildTargetCandidates(locator?: Locator): Locator[] {
  if (!locator) {
    return [];
  }
  const candidates: Locator[] = [];

  if (locator.eid) {
    candidates.push({ eid: locator.eid });
  }
  if (locator.role || locator.name) {
    candidates.push({ role: locator.role, name: locator.name });
  }
  if (locator.text) {
    candidates.push({ text: locator.text });
  }
  if (locator.css) {
    candidates.push({ css: locator.css });
  }

  return candidates;
}

function maybeParameterize(text: string, fieldName: string): { value: string; field?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { value: text };
  }

  if (trimmed.length >= 2) {
    return { value: `{{${fieldName}}}`, field: fieldName };
  }

  return { value: text };
}

export function extractSkillFromEpisode(episode: Episode): Omit<Skill, 'id' | 'createdAt' | 'stats'> {
  const paramsSchema: Skill['paramsSchema'] = {
    required: [],
    fields: {}
  };

  let paramIndex = 1;

  const plan = episode.steps.map((step) => {
    if (step.kind !== 'type' || !step.text) {
      return {
        ...step,
        targetCandidates: step.targetCandidates ?? buildTargetCandidates(step.locator)
      } satisfies SkillPlanStep;
    }

    const paramName = `param_${paramIndex}`;
    paramIndex += 1;
    const parameterized = maybeParameterize(step.text, paramName);
    if (parameterized.field) {
      paramsSchema.required?.push(parameterized.field);
      paramsSchema.fields[parameterized.field] = {
        type: 'string',
        description: `Auto extracted from intent: ${episode.intent}`
      };
    }

    return {
      ...step,
      text: parameterized.value,
      targetCandidates: step.targetCandidates ?? buildTargetCandidates(step.locator)
    } satisfies SkillPlanStep;
  });

  return {
    domain: episode.domain,
    intent: episode.intent,
    description: `Skill extracted from episode ${episode.id}`,
    plan,
    paramsSchema,
    healing: {
      retries: 1
    }
  };
}

function textScore(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) {
    return 1;
  }
  if (la.includes(lb) || lb.includes(la)) {
    return 0.7;
  }

  const tokensA = new Set(la.split(/\s+/).filter(Boolean));
  const tokensB = new Set(lb.split(/\s+/).filter(Boolean));
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function retrieveSkills(
  skills: Skill[],
  query: { domain: string; intent: string; anchors?: string[] }
): Skill[] {
  const ranked = skills
    .map((skill) => {
      const domainScore = skill.domain === query.domain ? 1 : 0;
      const intentScore = textScore(skill.intent, query.intent);
      const anchorScore =
        query.anchors && query.anchors.length > 0
          ? Math.max(...query.anchors.map((anchor) => textScore(skill.description, anchor)))
          : 0;
      const score = domainScore * 0.55 + intentScore * 0.35 + anchorScore * 0.1;
      return { skill, score };
    })
    .filter((item) => item.score > 0.2)
    .sort((a, b) => b.score - a.score);

  return ranked.map((item) => item.skill);
}

export function rankCandidates(
  elements: ElementMapItem[],
  candidateLocators: Locator[],
  limit = 3
): ElementMapItem[] {
  const scored = elements.map((element) => {
    let score = 0;
    for (const locator of candidateLocators) {
      if (locator.eid && locator.eid === element.eid) {
        score += 4;
      }
      if (locator.role && element.role && locator.role.toLowerCase() === element.role.toLowerCase()) {
        score += 1;
      }
      if (locator.name && textScore(locator.name, element.name) > 0) {
        score += textScore(locator.name, element.name) * 2;
      }
      if (locator.text && textScore(locator.text, element.text) > 0) {
        score += textScore(locator.text, element.text) * 1.5;
      }
      if (locator.css && element.selectors.css && locator.css === element.selectors.css) {
        score += 2;
      }
    }
    return { element, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.element);
}

export function inferDomainFromStartUrl(url: string): string {
  return getDomain(url);
}
