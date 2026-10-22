import "typespec-http-graphql";
import "./rest.tsp";

using HttpGraphQL;
using Surface;

// Two Query fields named `widget`: both are dropped.
@@queryField(Widgets.read, "widget");
@@queryField(Authors.read, "widget");

// A Mutation field of the same name is a different root type, and no collision.
@@mutationField(Widgets.create, "widget");
@@queryField(Widgets.list, "widgets");
