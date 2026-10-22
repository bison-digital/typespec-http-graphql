// The GraphQL surface's vocabulary. Applied with `@@`, in one `graphql.tsp`, so `rest.tsp` and the
// models carry no GraphQL. Each decorator only records; every check runs in the emitter.
//
// `Model` and `Operation` are reflection types, declared in `TypeSpec.Reflection`; without this
// `using` the extern declarations below fail with "Unknown identifier Operation".
using TypeSpec.Reflection;

namespace HttpGraphQL;

/** What a field's declaration may say beyond its name. */
model FieldOptions {
  /**
   * The field's description, in place of the operation's doc comment, which is written for REST: a
   * 404 a GraphQL client never sees, a query string it cannot send.
   */
  description?: string;
}

/** What a link's declaration may say beyond its name, its operation and its parameters. */
model LinkOptions extends FieldOptions {
  /**
   * The value of one of the model's properties that chooses this link: a property name, and the value
   * or values that call `operation`. Links of one model sharing a name, each with `when`, are one field
   * whose type is the union of their types. A value no link names is `null`, and calls nothing.
   */
  when?: Record<string | string[]>;

  /**
   * Call `operation`, a batch read, once for the distinct values of every parent a document reaches
   * at once, rather than once per value. The parameter this link fills from the parent is a list in
   * the query, and each answer's items are matched to the values by `key`.
   */
  batch?: BatchOptions;
}

/** How a batch read's answer is matched back to the values it was sent. */
model BatchOptions {
  /** The item property whose value is the value the item was asked for, as TypeSpec declares it. */
  key: string;

  /**
   * The answer's property holding the items, as TypeSpec declares it, where the answer is no list
   * itself and holds more than one list.
   */
  items?: string;
}

/**
 * Expose `target` as the root Query field `name`.
 *
 * @param target The operation the field calls.
 * @param name The field's name, used verbatim: by convention a noun, such as `book`.
 * @param options The field's description, where the operation's own does not suit GraphQL.
 */
extern dec queryField(target: Operation, name: valueof string, options?: valueof FieldOptions);

/**
 * Expose `target` as the root Mutation field `name`.
 *
 * @param target The operation the field calls.
 * @param name The field's name, used verbatim: by convention a verb phrase, such as `createBook`.
 * @param options The field's description, where the operation's own does not suit GraphQL.
 */
extern dec mutationField(target: Operation, name: valueof string, options?: valueof FieldOptions);

/**
 * Give `target`'s GraphQL object type a field `name`, resolved by calling `operation`. Each entry of
 * `parameters` fills one of the operation's parameters from one of `target`'s properties
 * (parameter name → property name, both as declared in TypeSpec). Every other parameter the
 * operation takes becomes an argument of the field. A property that is a list of values the parameter
 * accepts makes the field a list, calling the operation once per value; the list must declare
 * `@maxItems`. Several links sharing a name, each with `when`, are one field that calls only the
 * operation the parent's kind names.
 *
 * @param target The model whose GraphQL type gains the field.
 * @param name The field's name, used verbatim.
 * @param operation The operation the field calls. It must be a GET.
 * @param parameters Parameter name → property name, both as TypeSpec declares them.
 * @param options The field's description, where the operation's own does not suit GraphQL, and
 * `when`, the value of a property that chooses this link.
 */
extern dec link(
  target: Model,
  name: valueof string,
  operation: Operation,
  parameters?: valueof Record<string>,
  options?: valueof LinkOptions,
);

/**
 * Take `target`'s optional header `parameter` as input: an argument of every query field and link
 * that calls the operation, and a field of its mutation's input. An optional header is otherwise
 * left to the `/graphql` request; one that belongs to the single write it protects, such as an
 * `Idempotency-Key`, cannot be: two mutations in one document would share it.
 *
 * @param target The operation whose header it is.
 * @param parameter The header parameter, named as TypeSpec declares it.
 */
extern dec inputHeader(target: Operation, parameter: valueof string);

/**
 * Accept that `target` is projected as the `JSON` scalar, so no `projected-as-json` warning is raised
 * for it and `warn-as-error` stays usable: a property holding any JSON value, say. It makes nothing
 * JSON; on a type GraphQL can state, it is warned `not-projected-as-json`.
 *
 * @param target A model property, or a model, union, enum or scalar.
 */
extern dec json(target: ModelProperty | Model | Union | Enum | Scalar);
