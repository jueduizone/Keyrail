const SCALAR_PATTERN = /^([^:#][^:]*):(?:\s+(.*))?$/;

export function parseYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripComment(lines[index]);
    if (!rawLine.trim()) continue;

    const indent = rawLine.match(/^ */)[0].length;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;

    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`Invalid YAML list item on line ${index + 1}`);
      }
      parent.push(parseScalar(line.slice(2).trim()));
      continue;
    }

    const match = line.match(SCALAR_PATTERN);
    if (!match) {
      throw new Error(`Invalid YAML entry on line ${index + 1}`);
    }

    const [, key, rawValue] = match;
    if (rawValue === undefined || rawValue === "") {
      const next = nextContentLine(lines, index + 1);
      const container = next && next.indent > indent && next.line.trim().startsWith("- ") ? [] : {};
      parent[key.trim()] = container;
      stack.push({ indent, value: container });
      continue;
    }

    parent[key.trim()] = parseScalar(rawValue.trim());
  }

  return root;
}

export function stringifyYaml(value, indent = 0) {
  if (Array.isArray(value)) {
    return value.map((item) => `${" ".repeat(indent)}- ${formatScalar(item)}`).join("\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => {
        if (isEmptyCollection(entry)) {
          return `${" ".repeat(indent)}${key}: ${formatScalar(entry)}`;
        }
        if (entry && typeof entry === "object") {
          return `${" ".repeat(indent)}${key}:\n${stringifyYaml(entry, indent + 2)}`;
        }
        return `${" ".repeat(indent)}${key}: ${formatScalar(entry)}`;
      })
      .join("\n");
  }

  return `${" ".repeat(indent)}${formatScalar(value)}`;
}

function isEmptyCollection(value) {
  return Array.isArray(value) ? value.length === 0 : Boolean(value && typeof value === "object" && Object.keys(value).length === 0);
}

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === `"` || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

function nextContentLine(lines, start) {
  for (let index = start; index < lines.length; index += 1) {
    const line = stripComment(lines[index]);
    if (!line.trim()) continue;
    return { indent: line.match(/^ */)[0].length, line };
  }
  return null;
}

function parseScalar(value) {
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if ((value.startsWith(`"`) && value.endsWith(`"`)) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function formatScalar(value) {
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (value && typeof value === "object" && Object.keys(value).length === 0) return "{}";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "null";
  const text = String(value);
  if (!text || text.includes(": ") || text.startsWith("-") || text.includes("#")) {
    return JSON.stringify(text);
  }
  return text;
}
