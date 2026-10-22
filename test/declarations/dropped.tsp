import "./main.tsp";
import "typespec-http-graphql";

using HttpGraphQL;
using Catalog;

// A link whose property the parameter does not accept: dropped, and warned.
@@link(Category, "broken", Products.read, #{ id: "missing" });
