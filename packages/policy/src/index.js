const SHELL_CONTROL_TOKENS = new Set(["&&", "||", ";", "|", ">", ">>", "<"]);

export function evaluatePolicy({ command, context, policy = {}, confirmed = false }) {
  const normalized = normalizeCommand(command);

  if (!normalized) {
    return deny("No command was provided");
  }

  if (containsShellControl(command)) {
    return deny("Shell control operators are not allowed; pass a single command and arguments");
  }

  if (matchesAny(normalized, policy.deny ?? [])) {
    return deny(`Command is denied by policy: ${normalized}`);
  }

  const needsConfirmation =
    Boolean(context.requireConfirmation) ||
    context.risk === "high" ||
    matchesAny(normalized, policy.requireConfirm ?? []);

  if (needsConfirmation && !confirmed) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: `Command requires confirmation in ${context.name} context`
    };
  }

  const allow = policy.allow ?? [];
  if (allow.length > 0 && !matchesAny(normalized, allow)) {
    return deny(`Command is not allowed by policy: ${normalized}`);
  }

  return { allowed: true };
}

export function normalizeCommand(command) {
  if (!Array.isArray(command)) return "";
  return command.map((part) => String(part).trim()).filter(Boolean).join(" ");
}

export function commandPrefixMatches(command, pattern) {
  const commandParts = splitWords(command);
  const patternParts = splitWords(pattern);
  if (patternParts.length > commandParts.length) return false;
  return patternParts.every((part, index) => part === commandParts[index]);
}

function matchesAny(command, patterns) {
  return patterns.some((pattern) => commandPrefixMatches(command, pattern));
}

function containsShellControl(command) {
  return command.some((part) => SHELL_CONTROL_TOKENS.has(part));
}

function splitWords(value) {
  return String(value).trim().split(/\s+/).filter(Boolean);
}

function deny(reason) {
  return { allowed: false, reason };
}
