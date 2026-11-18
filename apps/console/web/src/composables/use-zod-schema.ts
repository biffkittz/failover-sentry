/**
 * Adapts a zod (v4) schema to VeeValidate's TypedSchema, so forms validate declaratively with the same schema
 * library as the rest of the project. (@vee-validate/zod still targets zod 3.)
 */
import type { TypedSchema, TypedSchemaError } from 'vee-validate';
import type { z } from 'zod';

export function zodTypedSchema<Schema extends z.ZodType>(
  schema: Schema,
): TypedSchema<z.input<Schema>, z.output<Schema>> {
  return {
    __type: 'VVTypedSchema',
    async parse(values) {
      const result = await schema.safeParseAsync(values);
      if (result.success) {
        return { value: result.data, errors: [] };
      }
      const byPath = new Map<string, string[]>();
      for (const issue of result.error.issues) {
        const path = issue.path.join('.');
        byPath.set(path, [...(byPath.get(path) ?? []), issue.message]);
      }
      const errors: TypedSchemaError[] = [...byPath].map(([path, messages]) => ({ path, errors: messages }));
      return { errors };
    },
  };
}
