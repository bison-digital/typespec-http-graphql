import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/** A catalogue's links: an id the read checks by pattern, and a list of ids. */
@service
namespace Catalog;

@pattern("^t-[0-9]+$")
scalar TagId extends string;

model Tag {
  id: string;
  label: string;
}

model Product {
  id: string;
  name: string;
  /** The product's own tag, by the product's id; ids are declared as plain strings. */
  tag_id: string;
  @maxItems(20) tag_ids?: string[] | null;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/products")
interface Products {
  @get read(@path id: string): Product | NotFound;
}

@route("/tags")
interface Tags {
  @get read(@path id: TagId): Tag | NotFound;
}

@@queryField(Products.read, "product");
@@link(Product, "firstTag", Tags.read, #{ id: "tag_id" });
@@link(Product, "tags", Tags.read, #{ id: "tag_ids" });
