// Imported first, so declared first, though its model sits further into its file than the other's:
// by file, then by position, `Paint` is declared before `Lamp`, and the alias they both hold is
// named after it.
//
// The lines below only move `Paint` further into this file than `Lamp` sits in its own.
//
// .........................................................................................
// .........................................................................................
// .........................................................................................
namespace Ordered;

model Paint {
  tone: Tone;
}
