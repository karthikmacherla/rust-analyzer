/* eslint-disable no-console */
import * as vscode from "vscode";
import * as lc from "vscode-languageclient";
import { testController } from ".";
import { assert, assertNever, isRustDocument } from "../util";
import { RaApiHelper } from "./api_helper";
import { RunnableFacde } from "./RunnableFacde";
import { performance } from "perf_hooks";
import { CargoMetadata } from "../toolchain";
import { CargoPackageNode, CargoWorkspaceNode, TargetNode, NodeKind, TestModuleNode, testModelTree, isTestModuleNode, WorkspacesVisitor, TestNode, Nodes, TargetKind, TestLikeNode, isTestNode } from "./test_model_tree";

let isInitilized = false;

export async function discoverAllFilesInWorkspaces() {
    if (!vscode.workspace.workspaceFolders) {
        return; // handle the case of no open folders
    }

    await refreshCore();

    isInitilized = true;
}

export function registerWatcherForWorkspaces() {
    if (!vscode.workspace.workspaceFolders) {
        return; // handle the case of no open folders
    }

    // listen to document changes to re-parse unsaved changes:
    vscode.workspace.onDidChangeTextDocument(e => {
        const document = e.document;

        if (!isRustDocument(document)) {
            return;
        }

        console.log("onDidChangeTextDocument callback");
        debounceHandleFileChangeCore(e.document.uri);
    });

    vscode.workspace.workspaceFolders
        .map(watchWorkspace);
}

function watchWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
    const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.rs');
    const watcher = vscode.workspace.createFileSystemWatcher(
        pattern,
    );

    watcher.onDidCreate(handleFileCreate);
    watcher.onDidChange(handleFileChange);
    watcher.onDidDelete(handleFileDelete);

    return watcher;
}

function debounce(fn: Function, ms: number) {
    let timeout: NodeJS.Timeout | undefined = undefined;
    return (...params: any[]) => {
        console.log("debounce debug: " + performance.now());
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            fn(...params);
        }, ms);
    };
}

// Why choose 2s:
// when auto save is enabled, there seems to be 2 events for workspace.onDidChangeTextDocument
// the first one is for the change of the file, the second one is for the save of the file
// And usually it takes about 1s between on my machine between the two events
const deboundeRefresh = debounce(refreshAllThings, 2000);
// FIXME: if there is changes in two files, we will lost the first chagne
const debounceHandleFileChangeCore = debounce(handleFileChangeCore, 2000);

export async function refreshAllThings() {
    if (!isInitilized) return;
    await refreshCore();
}

async function refreshCore() {
    if (!testController) return;

    // Discard all
    // testController.items.replace([]);
    testModelTree.clear();

    const cargoMetadataArray = await RaApiHelper.cargoWorkspaces();

    if (!cargoMetadataArray) return;

    // The workspaces got from RA contains depdencies(.i.e, RA does not add "--no-deps" when running `cargo metadata`)
    // However, tests in depdencies should be ignored.
    const noDepsWorkspaces = cargoMetadataArray.map(filterOutDepdencies);

    testModelTree.initByMedatada(noDepsWorkspaces);

    // After init, the target might not conatins any test(rather than not-fetched tests)
    // So we could not collect nodes which children need to be fetched, and fetch them
    // Instead, we pretend the behavior they are changed, so that the empty target will be removed

    const allTargetUris = noDepsWorkspaces.flatMap(it =>
        it.packages
            .flatMap(p => p.targets)
            .map(target => target.src_path)
            .map(vscode.Uri.file)
    );

    for (const uri of allTargetUris) {
        await updateModelByChangeOfFile(uri);
    }

    // attach test items
    updateTestItemsByModel();
}

function filterOutDepdencies(metadata: CargoMetadata) {
    return {
        ...metadata,
        packages: metadata.packages.filter(p =>
            metadata.workspace_members.includes(p.id)
        )
    };
}

async function handleFileCreate(uri: vscode.Uri) {
    console.log(`handleFileCreate triggered for ${uri}`);
    // Maybe we need to a "smart" strategy, when too much files changes in short time,
    // we change to rebuild all.

    await updateModelByChangeOfFile(uri);
    updateTestItemsByModel();
}

async function handleFileChangeCore(uri: vscode.Uri) {
    await updateModelByChangeOfFile(uri);
    updateTestItemsByModel();
}

async function handleFileChange(uri: vscode.Uri) {
    console.log(`handleFileChange triggered for ${uri}`);
    await debounceHandleFileChangeCore(uri);
}

async function handleFileDelete(uri: vscode.Uri) {
    console.log(`handleFileDelete triggered for ${uri}`);
    testModelTree.removeTestItemsRecursivelyByUri(uri);
    updateTestItemsByModel();
}

function updateTestItemsByModel() {
    testController!.items.replace([]);
    const rootTestItems = VscodeTestTreeBuilder.build();
    testController!.items.replace(rootTestItems);
}

async function getNormalizedTestRunnablesInFile(uri: vscode.Uri) {
    const rawRunables = await RaApiHelper.getTestRunnablesInFile(uri);

    assert(!!rawRunables);

    const runnables = rawRunables.map(it => new RunnableFacde(it));

    // User might copy and past test, and then there might be same name test or test module
    // Although it's wrong, we need to tolerate it.
    // choose the first one.
    return uniqueRunnables(runnables);

    function uniqueRunnables(runnables: RunnableFacde[]) {
        const map = new Map<string, RunnableFacde>();
        runnables.forEach(runnable => {
            const key = `${runnable.workspaceRoot}|${runnable.packageName}|${runnable.targetKind}|${runnable.targetName}|${runnable.origin.label}`;
            if (!map.has(key)) {
                map.set(key, runnable);
            }
        });
        return Array.from(map.values());
    }
}

async function updateModelByChangeOfFile(uri: vscode.Uri) {
    const runnables = await getNormalizedTestRunnablesInFile(uri);

    // Maybe from some to none
    // need to recursively clean the parent, until there is at least one test cases.
    if (runnables.length === 0) {
        testModelTree.removeTestItemsRecursivelyByUri(uri);
        return;
    }

    const testModuelRunnables = runnables.filter(it =>
        it.testKind === NodeKind.TestModule)
        .sort(RunnableFacde.sortByLabel);

    const testItemRunnables = runnables.filter(it =>
        it.testKind === NodeKind.Test);

    assert(testModuelRunnables.length + testItemRunnables.length === runnables.length);

    // FIXME: should be file test modules
    const rootTestModuleRunnbale = testModuelRunnables[0];

    // Now, we know the root test module
    // Note that the parent might be not exist in the tree.
    // Then how to update the test model tree?
    // There are two ways:
    // - down-to-up, which means get parent module,  and create parent recursively
    // - up-to-down, find the nearest parent, and create children for it
    // up-to-down is simpler, since the logic could be reused,
    // for anyway we need to init, which is up-to-dowm :P
    // PS: we could set dirty flag to make it more effective, but I think it's fine

    // Observe that:
    // if node is new in the tree, fetch its children too
    // if node is existing in the tree,
    // - and it's definition, then we have got all of the runnables(because they
    // are in same file) and will be updated
    // - and it's declaration
    //   - and definition uri is not changed, then not fetch children
    //   - and definition uri is changed, then fetch the children

    // So, the final steps are:
    // 1. Make the change(remove, add new test module declaration or add test module with items),
    // but not fetch children for new test module declaration
    // 2. collectt which children need to be fetched(reuse logic)
    // 3. fetch children(reuse logic)

    const nearestNode = testModelTree.findNearestNodeByRunnable(rootTestModuleRunnbale);

    assert(nearestNode.kind !== NodeKind.Test, "the nearest node of root module can not be a test node.");

    // create target node
    // This is necessary, because we do not know how many targets a package contains unless we fetch data of `cargo metadata`
    // But we want to only fetch it when cargo file is changed, to make things more lazily.
    if (rootTestModuleRunnbale.origin.label === "test-mod "
        && nearestNode.kind !== NodeKind.TestModule) {
        assert(nearestNode.kind === NodeKind.CargoPackage, "we do not delete package node unless refetch metadata");
        // TODO: what should we do if user add a new package or workspace?
        // Maybe listen to the change of cargo file, and always refresh everything
        // This runnable is from a target, create the target if it's not exist in test model tree
        const newTargetNode = new TargetNode(nearestNode,
            rootTestModuleRunnbale.targetKind,
            rootTestModuleRunnbale.targetName,
            rootTestModuleRunnbale.uri.fsPath);
        nearestNode.targets.add(newTargetNode);
    }

    // if nearest node is the node that the runnable represent, do the update stuff
    // TODO: for easy, we just remove the whole children for now
    //       but this is overkill, we could reuse the test modules
    //       if definition are same(and not in the same file)
    if (nearestNode.kind === NodeKind.TestModule
        && nearestNode.definitionUri.toString() === rootTestModuleRunnbale.uri.toString()
        && nearestNode.name === rootTestModuleRunnbale.testOrSuiteName) {
        nearestNode.testChildren.clear();
    }

    // collect nodes which children need to be fetched
    const nodeNeededFetched = FalsyLeavesCollector.collect(nearestNode);

    // fetch the children for nodes
    await fetchChildrenForFalsyLeaves(nodeNeededFetched);
}

async function fetchChildrenForFalsyLeaves(testModuleNodes: TestModuleNode[]) {
    // TODO: maybe concurrent?
    for (const testModuleNode of testModuleNodes) {
        await fetchChildrenForTestModuleNode(testModuleNode);
    }
}

async function fetchChildrenForTestModuleNode(testModuleNode: TestModuleNode) {
    assert(testModuleNode.testChildren.size === 0, "TestModuleNode must be leaf when update from up-to-down");
    assert(
        testModuleNode.isRootTestModule() ===
        (testModuleNode.declarationInfo.uri.toString() === testModuleNode.definitionUri.toString())
        , "if the test module is not a declaration module, it must be the root module of some target node");

    const definitionUri = testModuleNode.definitionUri;

    const runnables = await getNormalizedTestRunnablesInFile(definitionUri);

    await updateModelByRunnables(testModuleNode, runnables);
}

async function updateModelByRunnables(parentNode: TestModuleNode, runnables: RunnableFacde[]) {
    const testModuelRunnables = runnables.filter(it =>
        it.testKind === NodeKind.TestModule);

    const testRunnables = runnables.filter(it =>
        it.testKind === NodeKind.Test);

    assert(testModuelRunnables.length + testRunnables.length === runnables.length);

    const declarationModuleRunnables = testModuelRunnables.filter(isTestModuleDeclarationRunnable);
    const fileDefinitionModuleRunnables = testModuelRunnables.filter(isTestModuleFileDefinitionRunnable);
    const withItemsModuleRunnables = testModuelRunnables.filter(isTestModuleWithItemsRunnable);

    assert(declarationModuleRunnables.length + fileDefinitionModuleRunnables.length + withItemsModuleRunnables.length === testModuelRunnables.length);

    // Handle fileDefinitionModules
    // Not Handle fileDefinitionModule, we choose to use definition rather then declaration as the presentation of test module
    // which means, when find the test item in test explorer, will refirect to declaration rather than the file

    // Handle testRunnables and test modules which have items, which are in the same test file
    addTestModuleWithItemsRunnablesToTestModule(parentNode, withItemsModuleRunnables);
    addTestModuleWithItemsRunnablesToTestModule(parentNode, testRunnables);

    // Handle declarationModules
    // TODO: maybe concurrent?
    for (const declarationModuleRunnable of declarationModuleRunnables) {
        await addAndFetchDeclarationModuleRunnableToTestModule(parentNode, declarationModuleRunnable);
    }
}


async function addAndFetchDeclarationModuleRunnableToTestModule(parentNode: TestModuleNode, declarationModuleRunnable: RunnableFacde) {
    const definition = await getModuleDefinitionLocation(declarationModuleRunnable);

    // Add declarationModule node into the tree
    const testModule = new TestModuleNode(
        parentNode,
        declarationModuleRunnable.testOrSuiteName,
        declarationModuleRunnable.toTestLocation(),
        vscode.Uri.parse(definition.targetUri));
    parentNode.testChildren.add(testModule);

    // Fetch and update their definitions
    await fetchChildrenForTestModuleNode(testModule);
}

function addTestModuleWithItemsRunnablesToTestModule(parentNode: TestModuleNode, runnables: RunnableFacde[]) {
    // sort to ensure the parent is added before the chidren
    runnables.sort(RunnableFacde.sortByLabel)
        .forEach(runnable => {
            // TODO: Is this slow?
            const parentNode = testModelTree.findNearestNodeByRunnable(runnable);
            assert(parentNode.kind === NodeKind.TestModule, "Runable should be inserted into TestModule/Test, we create mock runnable for target/workspace node");
            if (!parentNode.isRootTestModule()) {
                assert(parentNode.name === runnable.testPaths[runnable.testPaths.length - 2]);
            }

            switch (runnable.testKind) {
                case NodeKind.Test:
                    const testNode = new TestNode(parentNode,
                        runnable.toTestLocation(),
                        runnable.testOrSuiteName);
                    runnableByTestModel.set(testNode, runnable);
                    parentNode.testChildren.add(testNode);
                    break;
                case NodeKind.TestModule:
                    const testModuleNode = new TestModuleNode(
                        parentNode,
                        runnable.testOrSuiteName,
                        runnable.toTestLocation(),
                        runnable.uri,
                    );
                    runnableByTestModel.set(testModuleNode, runnable);
                    parentNode.testChildren.add(testModuleNode);
                    break;
                default:
                    assertNever(runnable.testKind);
            }
        });
}

function noop() { }

// if a node is test module or target, it is a "flasy leaf".
// the only true leaf should be test.
class FalsyLeavesCollector extends WorkspacesVisitor {
    private constructor() { super(); }

    private static singlton = new FalsyLeavesCollector();

    public static collect(node?: Nodes) {
        const { singlton } = FalsyLeavesCollector;
        singlton.result.clear();
        singlton.apply(node);
        return Array.from(singlton.result);
    }

    private result: Set<TestModuleNode> = new Set();

    protected override visitCargoWorkspaceNodeCallback = noop;
    protected override visitCargoPackageNodeCallback = noop;
    protected override visitTargetNodeCallback = noop;

    protected override visitTestModuleNodeCallback(node: TestModuleNode): void {
        if (node.testChildren.size === 0) {
            this.result.add(node);
        }
    }

    protected override visitTestNodeCallback = noop;
}

const testItemByTestLike = new Map<TestLikeNode, vscode.TestItem>();
const testModelByTestItem = new WeakMap<vscode.TestItem, Nodes>();
const runnableByTestModel = new WeakMap<Nodes, RunnableFacde>();

export function getTestItemByTestLikeNode(testLikeNode: TestLikeNode) {
    const testItem = testItemByTestLike.get(testLikeNode);
    assert(!!testItem);
    return testItem;
}

export function getTestModelByTestItem(testItem: vscode.TestItem) {
    const testModel = testModelByTestItem.get(testItem);
    assert(!!testModel);
    return testModel;
}

export function getRunnableByTestModel(testModel: Nodes) {
    const runnable = runnableByTestModel.get(testModel);
    assert(!!runnable);
    return runnable;
}

export function getRunnableByTestItem(testItem: vscode.TestItem) {
    const testModel = getTestModelByTestItem(testItem);
    const runnable = getRunnableByTestModel(testModel);
    return runnable;
}

// Build vscode.TestItem tree
// and bind TestModel and vscode.TestItem
class VscodeTestTreeBuilder extends WorkspacesVisitor {
    private constructor() { super(); }

    private static singlton = new VscodeTestTreeBuilder();

    public static build() {
        const { singlton } = VscodeTestTreeBuilder;
        testItemByTestLike.clear();
        singlton.apply();
        const result = singlton.rootsTestItems;
        singlton.rootsTestItems = [];
        singlton.testItemByNode.clear();
        return result;
    }

    private rootsTestItems: vscode.TestItem[] = [];

    private testItemByNode = new Map<Nodes, vscode.TestItem>();

    private addTestItemToParentOrRoot(node: Nodes, testItem: vscode.TestItem) {
        testModelByTestItem.set(testItem, node);
        if (isTestModuleNode(node) || isTestNode(node)) {
            testItemByTestLike.set(node, testItem);
        }
        this.testItemByNode.set(node, testItem);

        const parentTestItem = tryGetParentTestItem.call(this, node);
        if (parentTestItem) {
            parentTestItem.children.add(testItem);
        } else {
            this.rootsTestItems.push(testItem);
        }

        function tryGetParentTestItem(this: VscodeTestTreeBuilder, node: Nodes) {
            let curNode = node;
            while (curNode.parent) {
                const candidate = this.testItemByNode.get(curNode.parent);
                if (candidate) {
                    return candidate;
                }
                curNode = curNode.parent;
            }
            return undefined;
        }
    }

    // Need this, for we do not delete workace node unless refetch metadata.
    private isWorkspaceEmptyWithTests(node: CargoWorkspaceNode) {
        return node.members.every(this.isPackageEmptyWithTests);
    }

    // Need this, we do not delete package node unless refetch metadata.
    private isPackageEmptyWithTests(node: CargoPackageNode) {
        return node.targets.size === 0;
    }

    protected override visitCargoWorkspaceNodeCallback(node: CargoWorkspaceNode) {
        // if there is only one workspace, do not create a test item node for it
        // Flatten the items
        if (testModelTree.roots.length === 1) {
            return false;
        }
        // if there is no tests in workspace, not create test-item.
        // and not traversal subtree
        if (this.isWorkspaceEmptyWithTests(node)) {
            return true;
        }
        const testItem = testController!.createTestItem(node.workspaceRoot.toString(), `$(project)${node.workspaceRoot.fsPath}`, node.manifestPath);
        this.addTestItemToParentOrRoot(node, testItem);
        return false;
    }

    protected override visitCargoPackageNodeCallback(node: CargoPackageNode) {
        // if there is only one package, do not create a test item node for it
        // Flatten the items
        if (node.parent.members.length === 1) {
            return false;
        }
        // if there is no tests in workspace, not create test-item.
        // and not traversal subtree
        if (this.isPackageEmptyWithTests(node)) {
            return true;
        }
        const testItem = testController!.createTestItem(node.manifestPath.fsPath, `$(package)${node.name}`, node.manifestPath);
        this.addTestItemToParentOrRoot(node, testItem);
        return false;
    }

    protected override visitTargetNodeCallback(node: TargetNode) {
        // if there is only one target, do not create a test item node for it
        // Flatten the items
        if (node.parent.targets.size === 1) {
            return;
        }

        let icon: string;
        switch (node.targetKind) {
            case TargetKind.Binary:
                icon = "$(run)";
                break;
            case TargetKind.Library:
                icon = "$(library)";
                break;
            case TargetKind.IntegrationTest:
                icon = "$(beaker)";
                break;
            default:
                assertNever(node.targetKind);
        }

        const testItem = testController!.createTestItem(`${icon}${node.name}`, `${icon}${node.name}`, node.srcPath);
        this.addTestItemToParentOrRoot(node, testItem);
    }

    protected override visitTestModuleNodeCallback(node: TestModuleNode) {
        if (node.isRootTestModule()) {
            // not create test item for root test module, which is representated by corresponding target node.
            return;
        }
        const testItem = testController!.createTestItem(node.name, `$(symbol-module)${node.name}`, node.declarationInfo.uri);
        testItem.range = node.declarationInfo.range;
        this.addTestItemToParentOrRoot(node, testItem);
    }

    protected override visitTestNodeCallback(node: TestNode) {
        const testItem = testController!.createTestItem(node.name, `$(symbol-method)${node.name}`, node.location.uri);
        testItem.range = node.location.range;
        this.addTestItemToParentOrRoot(node, testItem);
    }
}

async function getModuleDefinitionLocation(runnable: RunnableFacde) {
    assert(isTestModuleDeclarationRunnable(runnable));
    const definitionLocations = await RaApiHelper.moduleDefinition(runnable.origin.location!);
    assert(definitionLocations?.length === 1, "There should always be one and only one module definition for any module declaration.");
    return definitionLocations[0];
}

// async function createMockPackageRootRunnable(testMetadata: TestMetadata) {
//     assert(testMetadata.origin.label === "test-mod ", "The testMetadata should only be direct 'root' level");
//     const it = await RaApiHelper.parentModue(vscode.Uri.parse(testMetadata.origin.location!.targetUri));
//     assert(!!it, "should always be cargo file");
//     assert(it.length === 1, "should be only one cargo file");
//     const cargoLocationLink = it[0];

//     const packageRunnable: ra.Runnable = {
//         label: 'test-mod ',
//         kind: 'cargo',
//         location: {
//             targetUri: cargoLocationLink.targetUri,
//             targetRange: cargoLocationLink.targetRange,
//             targetSelectionRange: cargoLocationLink.targetSelectionRange,
//         },
//         args: {
//             ...testMetadata.origin.args,
//             "cargoArgs": [
//                 "test",
//                 "--package",
//                 testMetadata.packageName,
//                 "--lib",
//                 "--bins",
//                 "--tests",
//             ],
//             // override the executableArgs, to remove any exiting target
//             executableArgs: [],
//         }
//     };

//     const packgeTestMetadata = new TestMetadata(packageRunnable);

//     return packgeTestMetadata;
// }

/**
 * Whether the module is a declaration like "mod xxx;"
 */
function isTestModuleDeclarationRunnable(item: RunnableFacde) {
    assert(item.testKind === NodeKind.TestModule, "Only compare definition for test module.");
    return !isTestModuleFileDefinitionRunnable(item)
        // filter out module with items
        // Not accurate. But who will write `mode xxx { ... }` in one line?
        && item.origin.location?.targetRange.end.line === item.origin.location?.targetSelectionRange.end.line;
}

/**
 * whether the moudle is a definition like "mod xxx { ... }"
 */
function isTestModuleWithItemsRunnable(item: RunnableFacde) {
    assert(item.testKind === NodeKind.TestModule, "Only compare definition for test module.");
    return !isTestModuleFileDefinitionRunnable(item)
        && !isTestModuleDeclarationRunnable(item);
}

/**
 * Whether the module is a file module definition.
 */
function isTestModuleFileDefinitionRunnable(item: RunnableFacde) {
    const runnable = item.origin;
    assert(item.testKind === NodeKind.TestModule, "Only compare definition for test module.");
    assert(!!runnable.location, "Should always have location");
    return isRangeValueEqual(
        runnable.location.targetRange,
        runnable.location.targetSelectionRange,
    );

    function isRangeValueEqual(a: lc.Range, b: lc.Range) {
        return isPositiionValueEqual(a.start, b.start)
            && isPositiionValueEqual(a.end, b.end);
    }

    function isPositiionValueEqual(a: lc.Position, b: lc.Position) {
        return a.line === b.line
            && a.character === b.character;
    }
}
