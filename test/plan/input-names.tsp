import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * Models named as input types are: one a request alone takes, one a read also answers, whose
 * output type owns the name, and one two input types are planned from.
 */
@service
namespace Bookshop;

model AuthorInput {
  name: string;
}

model ShelfInput {
  label: string;
}

/**
 * Hidden on create and shown on replace, so its create input type is `EditionCreateInputCreateInput`
 * and its replace input type `EditionCreateInputInput`: both would take its name, and neither does.
 */
model EditionCreateInput {
  @visibility(Lifecycle.Read, Lifecycle.Update) id: string;
  format: string;
}

/** Named as no input type is: it takes the suffix. */
model Draft {
  note: string;
}

model Book {
  @key @visibility(Lifecycle.Read) id: string;
  title: string;
}

@route("/books")
interface Books {
  @post create(@body body: { title: string; authors: AuthorInput[]; shelf: ShelfInput; draft: Draft }): {
    @statusCode _: 201;
    @body book: Book;
  };
  @route("/{bookId}") @get read(@path bookId: string): Book;
  @route("/{bookId}/shelf") @get shelf(@path bookId: string): ShelfInput;
  @route("/{bookId}/edition") @post addEdition(@path bookId: string, @body body: { edition: EditionCreateInput }): {
    @statusCode _: 201;
    @body book: Book;
  };
  @route("/{bookId}/edition") @put replaceEdition(@path bookId: string, @body body: { edition: EditionCreateInput }): Book;
}

@@queryField(Books.read, "book");
@@queryField(Books.shelf, "shelf");
@@mutationField(Books.create, "createBook");
@@mutationField(Books.addEdition, "addEdition");
@@mutationField(Books.replaceEdition, "replaceEdition");
