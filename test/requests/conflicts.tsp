import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A bookshop whose result unions have members sharing a field name with another response shape:
 * one union for each way two fields of one selection set can fail to merge (GraphQL 5.3.2). And the
 * shapes `resultPathsOf` walks below a member: a list at the root, a union nested in a wrapper, and
 * a union one of whose variants holds another of its own.
 */
@service
namespace Bookshop;

enum BookStatus {
  draft,
  published,
}

model Book {
  id: string;
  /** An enum, beside a problem's `Int!`. */
  status: BookStatus;
  /** Nullable, beside a problem's non-null `String!`. */
  title: string | null;
  /** A list, beside one label on another member. */
  labels: string[];
  /** An `Int!`, beside a `String!` on two other members. */
  edition: int32;
}

@error
model Problem {
  @statusCode _: 400;
  type: string;
  title: string;
  status: int32;
}

/** A member with a field of its own under the name another member's alias would be given first. */
@error
model Rejected {
  @statusCode _: 409;
  status: int32;
  statusIntNonNull: string;
}

model Shelved {
  @statusCode _: 202;
  edition: string;
  labels: string;
}

model Reserved {
  @statusCode _: 203;
  edition: string;
}

/** `value` is a leaf here, and an object on the wrapper of the other arm. */
model Shelf {
  name: string;
  value: int32;
}

model Printed {
  pages: int32;
}

model Digital {
  pages: int64;
}

/** On the wire as `{ kind, value }`: two payloads whose `pages` differ below the envelope. */
@discriminated
union Edition {
  print: Printed,
  digital: Digital,
}

model Format {
  kind: string;
  binding: string;
}

model Paperback {
  kind: "paperback";
}

model Ebook {
  kind: "ebook";
  bytes: int64;
}

/** Each variant is itself the member; a paperback's only other field is a link. */
@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Copy {
  paperback: Paperback,
  ebook: Ebook,
}

model Hardback {
  isbn: string;
  pages: int32;
}

model Audiobook {
  isbn: string;
  minutes: int32;
}

/** On the wire as `{ kind, value }`, and beside a problem, so GraphQL wraps it whole. */
@discriminated
union Release {
  hardback: Hardback,
  audiobook: Audiobook,
}

model TitleIs {
  kind: "title";
  title: string;
}

/** A rule over another rule: a variant whose payload is the union it is a variant of. */
model Not {
  kind: "not";
  rule: Rule;
}

@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Rule {
  title: TitleIs,
  not: Not,
}

@route("/books")
interface Books {
  @post create(@body body: {
    title: string;
  }): {
    @statusCode _: 201;
    @body book: Book;
  } | Problem | Rejected;

  @route("/{id}/shelve") @get shelve(@path id: string): Book | Shelved | Reserved;
  @route("/{id}/edition") @get edition(@path id: string): Edition;
  @route("/{id}/copy") @get copy(@path id: string): Copy;
  @route("/{id}/release") @post release(@path id: string): Release | Problem;
}

@route("/shelves")
interface Shelves {
  @route("/{id}") @get read(@path id: string): Shelf | {
    @statusCode _: 202;
    @body holdings: Printed[];
  };
  @route("/{id}/printings") @get printings(@path id: string): Printed[];
  @route("/{id}/rule") @get rule(@path id: string): Rule;
}

@route("/formats")
interface Formats {
  @route("/{kind}") @get read(@path kind: string): Format;
}

@@mutationField(Books.create, "createBook");
@@queryField(Books.shelve, "shelving");
@@queryField(Books.edition, "edition");
@@queryField(Books.copy, "copy");
@@queryField(Shelves.read, "shelf");
@@queryField(Formats.read, "format");
@@queryField(Shelves.printings, "printings");
@@queryField(Shelves.rule, "shelfRule");
@@mutationField(Books.release, "releaseBook");
@@link(Paperback, "format", Formats.read, #{ kind: "kind" });
