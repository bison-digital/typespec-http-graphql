import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A bookshop whose result unions have members sharing a field name with another response shape:
 * one union for each way two fields of one selection set can fail to merge (GraphQL 5.3.2).
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
}

@route("/shelves")
interface Shelves {
  @route("/{id}") @get read(@path id: string): Shelf | {
    @statusCode _: 202;
    @body holdings: Printed[];
  };
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
@@link(Paperback, "format", Formats.read, #{ kind: "kind" });
