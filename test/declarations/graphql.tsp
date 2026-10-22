import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Catalog;

@@queryField(Products.read, "product", #{ description: "One product, or null when there is none." });
@@queryField(Categories.read, "category");
@@mutationField(Products.create, "createProduct", #{ description: "Create a product." });
@@link(Product, "category", Categories.read, #{ id: "category_id" }, #{ description: "The product's category." });

// The projections as JSON this surface means: a property's type, and a named model, union and scalar.
@@json(Product.extra);
@@json(Settings);
@@json(Shade);
@@json(Opaque);
// Each optional header belongs to the one write, and is input of that mutation alone.
@@inputHeader(Products.create, "idempotencyKey");
// A reader's language, an argument of the query field and of the link that read a category.
@@inputHeader(Categories.read, "acceptLanguage");
