import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** A book whose lists are bounded by `@maxItems`, but one, so Type Cost can count what a read returns. */
@service
namespace Bookshop;

model Tag {
  label: string;
}

model Book {
  @key id: string;
  title: string;

  /** Bounded on the property. */
  @maxItems(10) tags: Tag[];

  /** Bounded by its array type, and optional, so nullable. */
  shelves?: ShelfList;

  /** Unbounded. */
  notes: Tag[];

  /** Bounded, and of scalars, which Type Cost weighs at nothing. */
  @maxItems(5) labels: string[];

  /** Bounded, and encoded as one string, the GraphQL type it is: no list. */
  @maxItems(2) @encode(ArrayEncoding.commaDelimited) extra: string[];
}

@maxItems(3)
model ShelfList is Tag[];

@route("/books")
interface Books {
  @route("/{bookId}") @get read(@path bookId: string): Book;
}

@@queryField(Books.read, "book");
