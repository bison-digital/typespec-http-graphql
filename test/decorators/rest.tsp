// The REST service, with no GraphQL in it. The removability oracle compiles this file on its own.
import "@typespec/http";

using Http;

@service(#{ title: "Books" })
namespace Books;

model Author {
  @key id: string;
  name: string;
}

model Book {
  @key id: string;
  author_id: string | null;
  title: string;
}

model CreateBook {
  title: string;
  author_id?: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/authors")
interface Authors {
  @get read(@path authorId: string): Author | NotFound;
}

@route("/books")
interface BooksApi {
  @get read(@path bookId: string): Book | NotFound;
  @get list(@query authorId?: string): Book[];
  @post create(@body body: CreateBook): Book;
}
