import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A shelf of books, paged forward by an opaque page token: the backend shape design.md's connections
 * are built over. The page size has no minimum, so a negative `first` reaches the runtime, which
 * Relay requires to refuse it.
 */
@service(#{ title: "Shelf" })
namespace Shelf;

model Book {
  id: string;
  title: string;
}

model Shelf {
  id: string;
  name: string;
}

model BookPage {
  @pageItems items: Book[];
  @continuationToken next?: string;
}

@route("/books")
interface Books {
  @list @get list(@query @pageSize size?: int32 = 3, @query @continuationToken token?: string): BookPage;
}

@route("/shelves")
interface Shelves {
  @get @route("/{shelfId}") read(@path shelfId: string): Shelf;

  @list
  @get
  @route("/{shelfId}/books")
  books(
    @path shelfId: string,
    @query @pageSize size?: int32 = 3,
    @query @continuationToken token?: string,
  ): BookPage;
}

@@queryField(Books.list, "books");
@@queryField(Shelves.read, "shelf");
@@link(Shelf, "books", Shelves.books, #{ shelfId: "id" });
