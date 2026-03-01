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

function isTemplateParam(value: string): boolean {
  return /^\{\{[a-zA-Z0-9_]+\}\}$/.test(value.trim());
}

function collectLocatorAnchors(locator: Locator | undefined): string[] {
  if (!locator) {
    return [];
  }

  return [locator.name, locator.text, locator.role, locator.css]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function collectStepAnchors(step: SkillPlanStep): string[] {
  const anchors: string[] = [];
  anchors.push(...collectLocatorAnchors(step.locator));

  if (Array.isArray(step.targetCandidates)) {
    for (const candidate of step.targetCandidates) {
      anchors.push(...collectLocatorAnchors(candidate));
    }
  }

  if (typeof step.waitFor?.value === 'string') {
    anchors.push(step.waitFor.value);
  }
  if (typeof step.url === 'string') {
    anchors.push(step.url);
  }
  if (typeof step.text === 'string' && !isTemplateParam(step.text)) {
    anchors.push(step.text);
  }

  return anchors
    .map((value) => value.trim())
    .filter(Boolean);
}

function collectSkillAnchors(skill: Skill): string[] {
  const anchors = new Set<string>();
  anchors.add(skill.intent);
  anchors.add(skill.description);

  for (const step of skill.plan) {
    for (const anchor of collectStepAnchors(step)) {
      anchors.add(anchor);
    }
  }

  return [...anchors.values()];
}

function normalizeMinScore(minScore: number | undefined): number {
  if (!Number.isFinite(minScore)) {
    return 0.2;
  }
  return Math.min(1, Math.max(0, minScore ?? 0.2));
}

function scoreDomain(skillDomain: string, queryDomain: string): number {
  const normalizedSkill = skillDomain.trim().toLowerCase();
  const normalizedQuery = queryDomain.trim().toLowerCase();

  if (!normalizedQuery || normalizedQuery === 'unknown') {
    return 0.6;
  }
  if (normalizedSkill === normalizedQuery) {
    return 1;
  }
  if (normalizedSkill.endsWith(`.${normalizedQuery}`) || normalizedQuery.endsWith(`.${normalizedSkill}`)) {
    return 0.7;
  }
  return 0;
}

function scoreAnchors(skill: Skill, queryAnchors: string[] | undefined): number {
  if (!queryAnchors || queryAnchors.length === 0) {
    return 0;
  }

  const skillAnchors = collectSkillAnchors(skill);
  if (skillAnchors.length === 0) {
    return 0;
  }

  const anchorScores = queryAnchors
    .map((anchor) => anchor.trim())
    .filter(Boolean)
    .map((anchor) => Math.max(...skillAnchors.map((candidate) => textScore(candidate, anchor))));

  if (anchorScores.length === 0) {
    return 0;
  }

  return anchorScores.reduce((sum, score) => sum + score, 0) / anchorScores.length;
}

export function retrieveSkills(
  skills: Skill[],
  query: { domain: string; intent: string; anchors?: string[]; minScore?: number }
): Skill[] {
  const minScore = normalizeMinScore(query.minScore);
  const ranked = skills
    .map((skill) => {
      const domainScore = scoreDomain(skill.domain, query.domain);
      const intentScore = Math.max(textScore(skill.intent, query.intent), textScore(skill.description, query.intent) * 0.85);
      const anchorScore = scoreAnchors(skill, query.anchors);
      const score = domainScore * 0.45 + intentScore * 0.35 + anchorScore * 0.2;
      return { skill, score };
    })
    .filter((item) => item.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.skill.createdAt !== b.skill.createdAt) {
        return b.skill.createdAt.localeCompare(a.skill.createdAt);
      }
      return a.skill.id.localeCompare(b.skill.id);
    });

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
