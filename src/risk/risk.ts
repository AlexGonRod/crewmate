import type {
  ChangeStats,
  CiResult,
  Report,
  RiskAssessment,
  RiskLevel,
  VerificationResult,
} from '../core/types';

interface SensitiveRule {
  name: string;
  score: number;
  patterns: RegExp[];
}

const SENSITIVE_RULES: SensitiveRule[] = [
  {
    name: 'authentication/security',
    score: 4,
    patterns: [/(^|\/)(auth|security|crypto|secret)(\/|\.|$)/i],
  },
  {
    name: 'database migrations',
    score: 4,
    patterns: [/(^|\/)migrations?(\/|$)/i, /\.sql$/i],
  },
  {
    name: 'infrastructure/deployment',
    score: 4,
    patterns: [
      /(^|\/)(infra|infrastructure|deploy|deployment|terraform|kubernetes|k8s|helm)(\/|$)/i,
      /(^|\/)Dockerfile(\..*)?$/i,
    ],
  },
  {
    name: 'CI configuration',
    score: 4,
    patterns: [/^\.github(\/|$)/i, /(^|\/)\.gitlab-ci\.yml$/i, /(^|\/)\.circleci(\/|$)/i],
  },
  {
    name: 'dependency manifests',
    score: 2,
    patterns: [
      /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|requirements\.txt|pyproject\.toml|Gemfile\.lock)$/i,
    ],
  },
];

export interface RiskInput {
  change: ChangeStats;
  testerReport?: Report | null;
  verifications?: VerificationResult[];
  ci?: {
    state: CiResult['state'];
  } | null;
}

function matchesSensitivePath(path: string): { name: string; score: number } | null {
  for (const rule of SENSITIVE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(path))) {
      return { name: rule.name, score: rule.score };
    }
  }
  return null;
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const reasons = new Set<string>();
  let score = 0;

  const { change } = input;

  for (const path of change.paths) {
    const sensitive = matchesSensitivePath(path);
    if (sensitive) {
      score += sensitive.score;
      reasons.add(`touches ${sensitive.name} (${path})`);
    }
  }

  if (change.files > 20) {
    score += 3;
    reasons.add(`large change: ${change.files} files`);
  } else if (change.files > 5) {
    score += 2;
    reasons.add(`medium change: ${change.files} files`);
  }

  const churn = change.additions + change.deletions;
  if (churn > 500) {
    score += 2;
    reasons.add(`large churn: ${churn} changed lines`);
  } else if (churn > 100) {
    score += 1;
    reasons.add(`moderate churn: ${churn} changed lines`);
  }

  const findings = input.testerReport?.payload.findings ?? [];
  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  if (blocking.length > 0) {
    score += 4;
    reasons.add(`${blocking.length} blocking tester finding(s)`);
  }
  if (warnings.length >= 2) {
    score += 3;
    reasons.add(`${warnings.length} tester warnings`);
  } else if (warnings.length === 1) {
    score += 2;
    reasons.add('1 tester warning');
  }

  const verifications = input.verifications ?? [];
  if (verifications.length > 0) {
    const failed = verifications.filter((verification) => verification.state !== 'passed');
    if (failed.length > 0) {
      score += 2;
      reasons.add(
        `failing verification: ${failed.map((verification) => verification.command).join(', ')}`,
      );
    }
  }

  if (input.ci && input.ci.state !== 'passed') {
    score += 2;
    reasons.add(`CI ${input.ci.state}`);
  }

  if (reasons.size === 0) {
    reasons.add(`small change: ${change.files} file(s), +${change.additions}/-${change.deletions}`);
  }

  const level: RiskLevel = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    level,
    score,
    reasons: [...reasons],
    change,
  };
}
