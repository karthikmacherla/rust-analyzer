import * as vscode from "vscode";
import { refreshHandler, resolveHandler, disposiables } from "./discover_and_update";
import { runHandler } from "./run_or_debug";

export let testController: vscode.TestController | undefined;

export function deactivateTestController(): void {
  testController?.dispose();
  while (disposiables.length !== 0) {
    const watcher = disposiables.pop();
    watcher?.dispose();
  }
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
    runHandler,
    true,
  );

  testController.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    runHandler,
    true,
  );


  testController.resolveHandler = resolveHandler;

  testController.refreshHandler = refreshHandler;
}
