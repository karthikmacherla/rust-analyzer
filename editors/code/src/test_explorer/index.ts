import * as vscode from "vscode";
import { discoverAllFilesInWorkspaces, refreshAllThings, registerWatcherForWorkspaces } from "./discover_and_update";
import { runHandler } from "./run_or_debug";

export let testController: vscode.TestController | undefined;

export function deactivateTestController(): void {
  testController?.dispose();
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

  testController.resolveHandler = async test => {
    const isFirstTimeToOpenWorkspace = !test;
    if (isFirstTimeToOpenWorkspace) {
      registerWatcherForWorkspaces();
      await discoverAllFilesInWorkspaces();
    }
  };

  testController.refreshHandler = refreshAllThings;
}
