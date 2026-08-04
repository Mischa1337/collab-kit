import { EditorView, basicSetup } from 'codemirror';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, completionKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { keymap, Decoration, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder, Compartment, StateEffect } from '@codemirror/state';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';

window.PGVendor = {
  EditorView, basicSetup, sql, oneDark,
  autocompletion, completionKeymap, acceptCompletion,
  keymap, Y, WebsocketProvider, yCollab,
  // für das Autor-Text-Coloring (Authorship-Decorations + Toggle):
  Decoration, ViewPlugin, RangeSetBuilder, Compartment, StateEffect,
};
