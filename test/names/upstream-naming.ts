/**
 * VENDORED, AS A TEST ORACLE ONLY. Never imported by `src/`.
 *
 * Source: https://github.com/microsoft/typespec
 * Path:   packages/graphql/src/lib/naming.ts
 * Commit: e5df94a8d5cf0ba64dd60b78d1494eef9e3a11bc
 * Licence: MIT, Copyright (c) Microsoft Corporation. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 *
 * Kept byte for byte below this header, and excluded from `oxfmt` so it stays comparable with the
 * source, except for these edits:
 * - removed `applyInterfaceSuffix`, `applyInputSuffix`, `typeNamePipeline` and
 *   `applyTypeNamePipeline`, which name interface and input types this emitter names elsewhere;
 * - `parts[parts.length - 1]!` in `stripNamespace`: the `!` is the only change to a kept line,
 *   needed under `noUncheckedIndexedAccess`. `split` never returns an empty array.
 */
import { camelCase, constantCase, pascalCase, split, splitSeparateNumbers } from "change-case";

export interface NamingContext {
  isInput: boolean;
  isInterface: boolean;
  inputQualifier?: string;
}

type NameTransform = (name: string, context: NamingContext) => string;

function stripNamespace(name: string, _context: NamingContext): string {
  const parts = name.trim().split(".");
  return parts[parts.length - 1]!;
}

function sanitizeForGraphQL(name: string, _context: NamingContext): string {
  name = name.replaceAll("[]", "Array");
  name = name.replaceAll(/\W/g, "_");
  if (!/^[_a-zA-Z]/.test(name)) {
    name = `_${name}`;
  }
  return name;
}

function splitWithAcronyms(skipStart: boolean, name: string): string[] {
  const parts = split(name);
  if (name === name.toUpperCase()) {
    return parts;
  }
  return parts.flatMap((part, index) => {
    if (skipStart && index === 0) return part;
    if (part.match(/^[A-Z]+$/)) return part.split("");
    return part;
  });
}

function toPascalCase(name: string, _context: NamingContext): string {
  if (/^[A-Z]+$/.test(name)) {
    return name;
  }
  return pascalCase(name, {
    prefixCharacters: "_",
    split: splitWithAcronyms.bind(null, false),
  });
}

function toCamelCase(name: string, _context: NamingContext): string {
  return camelCase(name, {
    prefixCharacters: "_",
    split: splitWithAcronyms.bind(null, true),
  });
}

function toConstantCase(name: string, _context: NamingContext): string {
  return constantCase(name, {
    split: splitSeparateNumbers,
    prefixCharacters: "_",
  });
}

const baseNamePipeline: NameTransform[] = [stripNamespace, sanitizeForGraphQL, toPascalCase];

const fieldNamePipeline: NameTransform[] = [sanitizeForGraphQL, toCamelCase];

const enumMemberPipeline: NameTransform[] = [sanitizeForGraphQL, toConstantCase];

const noContext: NamingContext = { isInput: false, isInterface: false };

export function applyBaseNamePipeline(name: string): string {
  return baseNamePipeline.reduce((n, transform) => transform(n, noContext), name);
}

export function applyFieldNamePipeline(name: string): string {
  return fieldNamePipeline.reduce((n, transform) => transform(n, noContext), name);
}

export function applyEnumMemberPipeline(name: string): string {
  return enumMemberPipeline.reduce((n, transform) => transform(n, noContext), name);
}
