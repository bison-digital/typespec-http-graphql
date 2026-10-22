import "./rest.tsp";
import "typespec-http-graphql";

using HttpGraphQL;
using Catalog;

@@queryField(Products.read, "product");
@@link(Product, "category", Categories.read, #{ id: "category_id" });

// A type GraphQL states as an object of its own: there is no JSON to accept.
@@json(Category);
// No such parameter; a path parameter; a required header; a header of one literal.
@@inputHeader(Products.read, "nope");
@@inputHeader(Products.read, "id");
@@inputHeader(Audits.read, "store");
@@inputHeader(Audits.read, "accept");
