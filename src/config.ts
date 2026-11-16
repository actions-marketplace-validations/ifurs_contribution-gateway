import { parse } from "yaml";

/** Values of `author_association` that GitHub puts on pull requests. */
export const ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const;
export type Association = (typeof ASSOCIATIONS)[number];

export interface Policy {
  /** "enforce" comments, labels, closes and fails the check; "dry-run" only logs. */
  mode: "enforce" | "dry-run";
  exempt: {
    associations: Association[];
    users: string[];
    bots: boolean;
    labels: string[];
  };
  rules: {
    linked_issue: {
      enabled: boolean;
      /** The referenced issue must still be open. */
      require_open: boolean;
      /** If set, the referenced issue must carry this label (e.g. "accepted"). */
      require_label: string;
    };
    open_pr_limit: {
      enabled: boolean;
      /** Maximum open PRs (including this one) an author in `applies_to` may have. */
      max: number;
      applies_to: Association[];
    };
    checklist: {
      enabled: boolean;
      /** Every `- [ ]` item in the PR description must be ticked. */
      require_all_checked: boolean;
      /** Minimum number of checklist items, so the template can't simply be deleted. */
      min_items: number;
    };
    disclosure: {
      enabled: boolean;
      /** Text of the line that starts the disclosure section, e.g. "AI usage". */
      heading: string;
    };
  };
  on_violation: {
    comment: boolean;
    /** Label added while the PR breaks the policy; removed once it passes. Empty disables. */
    label: string;
    close: boolean;
    fail_check: boolean;
    /** Optional text shown at the top of the bot comment. */
    intro: string;
  };
}

export const DEFAULT_POLICY: Policy = {
  mode: "enforce",
  exempt: {
    associations: ["OWNER", "MEMBER", "COLLABORATOR"],
    users: [],
    bots: true,
    labels: ["skip-gateway"],
  },
  rules: {
    linked_issue: { enabled: true, require_open: true, require_label: "" },
    open_pr_limit: {
      enabled: true,
      max: 1,
      applies_to: ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"],
    },
    checklist: { enabled: true, require_all_checked: true, min_items: 0 },
    disclosure: { enabled: false, heading: "AI usage" },
  },
  on_violation: {
    comment: true,
    label: "needs-policy-fixes",
    close: false,
    fail_check: true,
    intro: "",
  },
};

export class ConfigError extends Error {}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merges `input` over `defaults`, checking that every value has the same type as its
 * default. Unknown keys are reported as warnings rather than errors so that older
 * versions of the action keep working with newer config files.
 */
function merge(defaults: unknown, input: unknown, path: string, warnings: string[]): unknown {
  if (input === undefined || input === null) return defaults;
  if (isPlain(defaults)) {
    if (!isPlain(input)) throw new ConfigError(`${path} must be a mapping`);
    const out: Plain = {};
    for (const key of Object.keys(defaults)) {
      out[key] = merge(defaults[key], input[key], path ? `${path}.${key}` : key, warnings);
    }
    for (const key of Object.keys(input)) {
      if (!(key in defaults)) warnings.push(`Unknown config key "${path ? `${path}.` : ""}${key}" ignored`);
    }
    return out;
  }
  if (Array.isArray(defaults)) {
    if (!Array.isArray(input) || input.some((x) => typeof x !== "string")) {
      throw new ConfigError(`${path} must be a list of strings`);
    }
    return input;
  }
  if (typeof input !== typeof defaults) {
    throw new ConfigError(`${path} must be a ${typeof defaults}, got ${typeof input}`);
  }
  return input;
}

function checkAssociations(list: string[], path: string): void {
  for (const a of list) {
    if (!(ASSOCIATIONS as readonly string[]).includes(a)) {
      throw new ConfigError(`${path} contains "${a}"; expected one of ${ASSOCIATIONS.join(", ")}`);
    }
  }
}

export function parsePolicy(yamlText: string | undefined): { policy: Policy; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = yamlText ? parse(yamlText) : undefined;
  } catch (e) {
    throw new ConfigError(`Config is not valid YAML: ${(e as Error).message}`);
  }
  const policy = merge(DEFAULT_POLICY, raw, "", warnings) as Policy;

  if (policy.mode !== "enforce" && policy.mode !== "dry-run") {
    throw new ConfigError(`mode must be "enforce" or "dry-run", got "${policy.mode}"`);
  }
  checkAssociations(policy.exempt.associations, "exempt.associations");
  checkAssociations(policy.rules.open_pr_limit.applies_to, "rules.open_pr_limit.applies_to");
  const { max } = policy.rules.open_pr_limit;
  if (!Number.isInteger(max) || max < 1) throw new ConfigError("rules.open_pr_limit.max must be a whole number of at least 1");
  const { min_items } = policy.rules.checklist;
  if (!Number.isInteger(min_items) || min_items < 0) throw new ConfigError("rules.checklist.min_items must be a whole number of at least 0");
  // The heading is also used to set the disclosure section aside from the checklist, so it is
  // checked even when the disclosure rule is off. Very short headings would match too much.
  if (policy.rules.disclosure.heading.trim().length < 3) {
    throw new ConfigError("rules.disclosure.heading must be at least 3 characters");
  }
  const label = policy.on_violation.label.trim().toLowerCase();
  if (label && policy.exempt.labels.some((l) => l.trim().toLowerCase() === label)) {
    throw new ConfigError(
      `on_violation.label "${policy.on_violation.label}" is also in exempt.labels, so the first failure would exempt the PR from all later checks`,
    );
  }
  return { policy, warnings };
}
