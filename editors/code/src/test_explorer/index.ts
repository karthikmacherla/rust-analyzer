import * as vscode from "vscode";
import { onDidChangeActiveTextEditorForTestExplorer, refreshAllThings, resolveHandler } from "./discover_and_update";
import { runHandler } from "./run_or_debug";

export let testController: vscode.TestController | undefined;
let disposeChangeAcitveTextEditor: vscode.Disposable;

export function deactivateTestController(): void {
  testController?.dispose();
  disposeChangeAcitveTextEditor.dispose();
  testController = undefined;
}

export function activeTestController(): void {
  testController?.dispose();

  testController = vscode.tests.createTestController(
    'rust-analyzer-test-controller',
    'Rust Tests'
  );

  testController.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      await runHandler(request, token);
    },
    true,
  );

  testController.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    async (request, token) => {
      await runHandler(request, token);
    },
    true,
  );

  disposeChangeAcitveTextEditor = vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditorForTestExplorer);

  testController.resolveHandler = resolveHandler;

  testController.refreshHandler = refreshAllThings;
}
