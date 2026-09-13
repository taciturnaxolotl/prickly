/**
 * A very small schema combinator.
 *
 * Tools need two things from a schema: a JSON Schema to advertise, and a
 * validator so a bad argument fails with a sentence the model can act on
 * rather than a TypeError three frames deep. Pulling in a validation library
 * for that would be most of the extension's bundle, so this is the whole
 * feature set and nothing else.
 */

export interface Schema<T> {
  toJSON(): Record<string, unknown>;
  parse(value: unknown, path: string): T;
  readonly isOptional: boolean;
  readonly defaultValue?: T;
}

export class ValidationError extends Error {}

function fail(path: string, expected: string, got: unknown): never {
  const actual =
    got === undefined ? "nothing" : Array.isArray(got) ? "an array" : `a ${typeof got}`;
  throw new ValidationError(`${path} must be ${expected}, got ${actual}`);
}

interface Options<T> {
  description?: string;
  optional?: boolean;
  default?: T;
}

function base<T>(
  json: Record<string, unknown>,
  check: (value: unknown, path: string) => T,
  opts: Options<T>,
): Schema<T> {
  return {
    isOptional: opts.optional === true || opts.default !== undefined,
    defaultValue: opts.default,
    toJSON: () => (opts.description ? { ...json, description: opts.description } : json),
    parse(value, path) {
      if (value === undefined || value === null) {
        if (opts.default !== undefined) return opts.default;
        if (opts.optional) return undefined as T;
        throw new ValidationError(`${path} is required`);
      }
      return check(value, path);
    },
  };
}

export const s = {
  string(opts: Options<string> & { pattern?: string } = {}) {
    return base<string>(
      { type: "string", ...(opts.pattern ? { pattern: opts.pattern } : {}) },
      (v, p) => (typeof v === "string" ? v : fail(p, "a string", v)),
      opts,
    );
  },

  number(opts: Options<number> & { min?: number; max?: number; integer?: boolean } = {}) {
    return base<number>(
      {
        type: opts.integer ? "integer" : "number",
        ...(opts.min !== undefined ? { minimum: opts.min } : {}),
        ...(opts.max !== undefined ? { maximum: opts.max } : {}),
      },
      (v, p) => {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n !== "number" || Number.isNaN(n)) fail(p, "a number", v);
        if (opts.integer && !Number.isInteger(n)) fail(p, "an integer", v);
        if (opts.min !== undefined && n < opts.min) {
          throw new ValidationError(`${p} must be at least ${opts.min}`);
        }
        if (opts.max !== undefined && n > opts.max) {
          throw new ValidationError(`${p} must be at most ${opts.max}`);
        }
        return n;
      },
      opts,
    );
  },

  boolean(opts: Options<boolean> = {}) {
    return base<boolean>(
      { type: "boolean" },
      (v, p) => {
        if (typeof v === "boolean") return v;
        if (v === "true") return true;
        if (v === "false") return false;
        return fail(p, "a boolean", v);
      },
      opts,
    );
  },

  enum_<const V extends readonly string[]>(values: V, opts: Options<V[number]> = {}) {
    return base<V[number]>(
      { type: "string", enum: [...values] },
      (v, p) => {
        if (typeof v === "string" && values.includes(v)) return v as V[number];
        throw new ValidationError(`${p} must be one of: ${values.join(", ")}`);
      },
      opts,
    );
  },

  array<T>(item: Schema<T>, opts: Options<T[]> & { maxItems?: number } = {}) {
    return base<T[]>(
      {
        type: "array",
        items: item.toJSON(),
        ...(opts.maxItems !== undefined ? { maxItems: opts.maxItems } : {}),
      },
      (v, p) => {
        if (!Array.isArray(v)) fail(p, "an array", v);
        if (opts.maxItems !== undefined && v.length > opts.maxItems) {
          throw new ValidationError(`${p} must have at most ${opts.maxItems} items`);
        }
        return v.map((item_, i) => item.parse(item_, `${p}[${i}]`));
      },
      opts,
    );
  },

  /** A fixed-length numeric pair, for coordinates. */
  point(opts: Options<[number, number]> = {}) {
    return base<[number, number]>(
      { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      (v, p) => {
        if (!Array.isArray(v) || v.length !== 2) fail(p, "an [x, y] pair", v);
        const [x, y] = v as unknown[];
        if (typeof x !== "number" || typeof y !== "number") {
          fail(p, "an [x, y] pair of numbers", v);
        }
        return [x, y];
      },
      opts,
    );
  },

  record(opts: Options<Record<string, string>> = {}) {
    return base<Record<string, string>>(
      { type: "object", additionalProperties: { type: "string" } },
      (v, p) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p, "an object", v);
        const out: Record<string, string> = {};
        for (const [k, value] of Object.entries(v)) out[k] = String(value);
        return out;
      },
      opts,
    );
  },

  object<S extends Record<string, Schema<unknown>>>(
    shape: S,
    opts: Options<never> = {},
  ): Schema<{ [K in keyof S]: S[K] extends Schema<infer T> ? T : never }> {
    const required = Object.entries(shape)
      .filter(([, schema]) => !schema.isOptional)
      .map(([key]) => key);

    return base(
      {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape).map(([key, schema]) => [key, schema.toJSON()]),
        ),
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      },
      (v, p) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p, "an object", v);
        const input = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(shape)) {
          const parsed = schema.parse(input[key], p ? `${p}.${key}` : key);
          if (parsed !== undefined) out[key] = parsed;
        }
        return out as never;
      },
      opts as Options<never>,
    ) as Schema<{ [K in keyof S]: S[K] extends Schema<infer T> ? T : never }>;
  },

  /** Escape hatch for genuinely free-form values. */
  any(opts: Options<unknown> = {}) {
    return base<unknown>({}, (v) => v, opts);
  },
};

export type Infer<S> = S extends Schema<infer T> ? T : never;

/** The object-shaped top level every tool has. */
export function objectSchemaJSON(shape: Record<string, Schema<unknown>>) {
  return s.object(shape).toJSON() as {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}
