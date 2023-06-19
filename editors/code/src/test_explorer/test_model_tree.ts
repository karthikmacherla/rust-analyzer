import path = require("node:path");
import * as vscode from 'vscode';
import { CargoMetadata, CargoPackageMetadata, CargoTargetKind, CargoTargetMetadata } from "../toolchain";
import { assert, assertNever } from "../util";
import { RunnableFacde } from "./RunnableFacde";
import { fail } from "node:assert";

export enum NodeKind {
    // VSCodeWorkSpace,
    CargoWorkspace,
    CargoPackage,
    Target,
    TestModule,
    Test,
}

export enum TargetKind {
    Library,
    IntegrationTest,
    Binary,
}

export namespace TargetKind {
    export function from(cargoTargetKinds: CargoTargetKind[]) {
        if (cargoTargetKinds.length === 1) {
            switch (cargoTargetKinds[0]) {
                case CargoTargetKind.Binary:
                    return TargetKind.Binary;
                case CargoTargetKind.Lib:
                case CargoTargetKind.RustLib:
                case CargoTargetKind.CDynamicLib:
                case CargoTargetKind.DynamicLib:
                case CargoTargetKind.StaticLib:
                    return TargetKind.Library;
                case CargoTargetKind.Test:
                    return TargetKind.IntegrationTest;
                case CargoTargetKind.Example:
                case CargoTargetKind.Bench:
                case CargoTargetKind.BuildScript:
                    return undefined;
                default:
                    assertNever(cargoTargetKinds[0]);
            }
        } else if (cargoTargetKinds.every(it =>
            CargoTargetKind.isLibraryLike(it))) {
            return TargetKind.Library;
        } else {
            fail("Oops, you met an unknown situation that RA could not verify the kind of the target");
        }
    }
}

interface Node {
    readonly parent: Node | undefined;
    readonly kind: NodeKind;
}

export class WorkspacesVisitor {
    protected constructor() { }

    protected visitCargoWorkspaceNodeCallback(_node: CargoWorkspaceNode): boolean | void { }
    protected visitCargoPackageNodeCallback(_node: CargoPackageNode): boolean | void { }
    protected visitTargetNodeCallback(_node: TargetNode): boolean | void { }
    protected visitTestModuleNodeCallback(_node: TestModuleNode): boolean | void { }
    protected visitTestNodeCallback(_node: TestNode): void { }

    protected apply(node?: Nodes): void {
        switch (node?.kind) {
            case NodeKind.CargoWorkspace:
                this.visitCargoWorkspaceNode(node);
                break;
            case NodeKind.CargoPackage:
                this.visitCargoPackageNode(node);
                break;
            case NodeKind.Target:
                this.visitTargetNode(node);
                break;
            case NodeKind.TestModule:
                this.visitTestModuleNode(node);
                break;
            case NodeKind.Test:
                this.visitTestNode(node);
                break;
            default:
                testModelTree.roots.forEach(workspaceNode =>
                    this.visitCargoWorkspaceNode(workspaceNode));
                break;
        }
    }

    private visitCargoWorkspaceNode(cargoWorkspaceNode: CargoWorkspaceNode) {
        if (this.visitCargoWorkspaceNodeCallback(cargoWorkspaceNode)) { return; };
        cargoWorkspaceNode.members.forEach(packageNode =>
            this.visitCargoPackageNode(packageNode));
    }

    private visitCargoPackageNode(cargoPackageNode: CargoPackageNode) {
        if (this.visitCargoPackageNodeCallback(cargoPackageNode)) { return; };
        cargoPackageNode.targets.forEach(targetNode =>
            this.visitTargetNode(targetNode));
    }

    private visitTargetNode(targetNode: TargetNode) {
        if (this.visitTargetNodeCallback(targetNode)) { return; };
        if (targetNode.rootTestModule) {
            this.visitTestModuleNode(targetNode.rootTestModule);
        }
    }

    private visitTestModuleNode(testModuleNode: TestModuleNode) {
        if (this.visitTestModuleNodeCallback(testModuleNode)) { return; };
        testModuleNode.testChildren.forEach(it => {
            switch (it.kind) {
                case NodeKind.TestModule:
                    this.visitTestModuleNode(it);
                    break;
                case NodeKind.Test:
                    this.visitTestNode(it);
                    break;
                default:
                    assertNever(it);
            }
        });
    }

    private visitTestNode(testNode: TestNode) {
        this.visitTestNodeCallback(testNode);
    }
}

// The vscode-test-items-tree is view
// CargoWorkspaceNode is model
// This is controller-like, but it does not have any IO
export class WorkspacesRoot {
    readonly roots: CargoWorkspaceNode[] = [];

    clear() {
        this.roots.splice(0, this.roots.length);
    }

    // after init, there are target nodes(with its root test module), but there is no TestModule/Test
    initByMedatada(metadata: CargoMetadata[]) {
        metadata.forEach((m) => {
            const cargoWorkspace = CargoWorkspaceNode.from(m);
            this.roots.push(cargoWorkspace);
        });
    }

    findNearestNodeByRunnable(runnable: RunnableFacde) {
        const {
            workspaceRoot,
            packageName,
            targetKind,
            targetName,
            testPaths,
            testKind,
        } = runnable;

        const workspaceNode = this.roots.find((root) => root.workspaceRoot.fsPath.toLowerCase() === workspaceRoot.toLowerCase());
        assert(!!workspaceNode);

        const packageNode = workspaceNode?.members.find((p) => p.name === packageName);
        if (!packageNode) {
            return workspaceNode;
        }

        const targetNode = Array.from(packageNode.targets).find((t) => t.name === targetName && t.targetKind === targetKind);
        if (!targetNode) {
            return packageNode;
        }

        assert(!!targetNode.rootTestModule);

        return this.findTestLikeNodeUnderTarget(targetNode, testKind, testPaths);
    }

    findTestLikeNodeUnderTarget(targetNode: TargetNode, testLevel: NodeKind.TestModule, testPaths: string[]): TestModuleNode;
    findTestLikeNodeUnderTarget(targetNode: TargetNode, testLevel: NodeKind.Test, testPaths: string[]): TestNode;
    findTestLikeNodeUnderTarget(targetNode: TargetNode, testLevel: TestLikeNodeKind, testPaths: string[]): TestLikeNode;
    findTestLikeNodeUnderTarget(targetNode: TargetNode, testLevel: TestLikeNodeKind, testPaths: string[]): TestLikeNode {
        let testModuleNode: TestModuleNode = targetNode.rootTestModule;

        for (let index = 0; index < testPaths.length; index += 1) {
            const testModuleNmae = testPaths[index];
            const targetKind = index === testPaths.length - 1 ? testLevel : NodeKind.TestModule;

            const candidate = Array.from(testModuleNode.testChildren).find((t) =>
                t.kind === targetKind &&
                t.name === testModuleNmae);

            if (!candidate) {
                return testModuleNode;
            }

            if (index === testPaths.length - 1) {
                return candidate;
            }

            assert(candidate.kind === NodeKind.TestModule);
            testModuleNode = candidate;
        }

        throw new Error("Should not reach here");
    }

    /**
     * Remove the Target/TestModule/Test recusively,
     * until there is at least one item after removed.
     */
    removeTestItemsRecursivelyByUri(uri: vscode.Uri): void {
        const nodes: TestLikeNode[] = UriMatcher.match(uri);
        nodes.forEach(removeRecursively);
    }
}

function noop() { }

class UriMatcher extends WorkspacesVisitor {
    private static singlton = new UriMatcher();

    private currentUri: vscode.Uri | undefined;

    public static match(uri: vscode.Uri) {
        const { singlton } = UriMatcher;
        singlton.result.clear();
        singlton.currentUri = uri;
        singlton.apply();
        return Array.from(singlton.result);
    }

    private result: Set<TestModuleNode> = new Set();

    protected override visitCargoWorkspaceNodeCallback = noop;
    protected override visitCargoPackageNodeCallback = noop;
    protected override visitTargetNodeCallback = noop;

    protected override visitTestModuleNodeCallback(node: TestModuleNode): boolean {
        assert(!!this.currentUri);
        if (node.definitionUri.toString() === this.currentUri.toString()) {
            this.result.add(node);
            return true;
        }
        return false;
    }

    protected override visitTestNodeCallback = noop;
}

function removeRecursively(node: TestLikeNode) {
    // delete the node from parent, until
    // - after removing, the parent of node still has at least one node,
    // - Or the parent of node is package node
    let curNode: RsNode | CargoPackageNode = node;
    while (true) {
        const parent: TestModuleNode | TargetNode | CargoPackageNode = curNode.parent;
        switch (parent.kind) {
            case NodeKind.CargoPackage: {
                assert(curNode.kind === NodeKind.Target);
                const isDeleted = parent.targets.delete(curNode);
                assert(isDeleted, "node must be in the children of the parent");
                break;
            }
            case NodeKind.Target:
                break;
            case NodeKind.TestModule: {
                assert(
                    curNode.kind === NodeKind.Test
                    || curNode.kind === NodeKind.TestModule
                );
                const isDeleted = parent.testChildren.delete(curNode);
                assert(isDeleted, "node must be in the children of the parent");
                break;
            }
            default:
                assertNever(parent);
        }

        curNode = parent;

        if (curNode.kind === NodeKind.CargoPackage) {
            break;
        }

        if (curNode.kind === NodeKind.TestModule && curNode.testChildren.size > 0) {
            break;
        }
    }
}

export const testModelTree = new WorkspacesRoot();

export class CargoWorkspaceNode implements Node {
    readonly parent: undefined;
    readonly kind = NodeKind.CargoWorkspace;
    readonly workspaceRoot: vscode.Uri;
    readonly manifestPath: vscode.Uri;
    readonly members: CargoPackageNode[] = [];

    static from(metadata: CargoMetadata): CargoWorkspaceNode {
        const res = new CargoWorkspaceNode(metadata.workspace_root);

        assert(metadata.packages.length === metadata.workspace_members.length, "cargo medatada should only not contain depdencies");

        metadata.packages.forEach((p) => {
            const newPackageNode = CargoPackageNode.from(p, res);
            res.members.push(newPackageNode);
        });
        return res;
    }

    private constructor(workspaceRoot: string) {
        this.workspaceRoot = vscode.Uri.file(workspaceRoot);
        this.manifestPath = vscode.Uri.file(path.join(workspaceRoot, 'Cargo.toml'));
    }
}

export class CargoPackageNode implements Node {
    readonly parent: CargoWorkspaceNode;
    readonly name: string;
    readonly kind = NodeKind.CargoPackage;
    // cargo path
    readonly manifestPath: vscode.Uri;
    readonly targets: Set<TargetNode> = new Set();

    static from(packageMetadata: CargoPackageMetadata, parent: CargoWorkspaceNode): CargoPackageNode {
        const res = new CargoPackageNode(parent, packageMetadata.manifest_path, packageMetadata.name);

        packageMetadata.targets.forEach(target => {
            const newTargetNode = TargetNode.from(target, res);
            if (!newTargetNode) {
                return;
            }

            res.targets.add(newTargetNode);
        });
        return res;
    }

    private constructor(parent: CargoWorkspaceNode, manifestPath: string, name: string) {
        this.parent = parent;
        this.manifestPath = vscode.Uri.file(manifestPath);
        this.name = name;
    }
}

export class TargetNode implements Node {
    readonly parent: CargoPackageNode;
    readonly kind = NodeKind.Target;
    readonly name: string;
    readonly srcPath: vscode.Uri;
    readonly targetKind: TargetKind;
    rootTestModule: TestModuleNode;

    static from(targetMetadata: CargoTargetMetadata, parent: CargoPackageNode): TargetNode | undefined {
        const targetKind = TargetKind.from(targetMetadata.kind);
        if (targetKind === undefined) return undefined;

        const res = new TargetNode(parent, targetKind, targetMetadata.name, targetMetadata.src_path);
        return res;
    }

    constructor(parent: CargoPackageNode, targetKind: TargetKind, name: string, srcPath: string) {
        this.parent = parent;
        this.targetKind = targetKind;
        this.name = name;
        this.srcPath = vscode.Uri.file(srcPath);
        this.rootTestModule = new TestModuleNode(
            this,
            '',
            {
                uri: this.srcPath,
                range: new vscode.Range(0, 0, 0, 0),
            },
            this.srcPath);
    }
}

export type TestLikeNode = TestModuleNode | TestNode;
export type TestLikeNodeKind = NodeKind.TestModule | NodeKind.Test;

/**
 * Nodes which has a linked "rs" file.
 */
type RsNode = TestLikeNode | TargetNode;

export interface TestLocation {
    uri: vscode.Uri;
    range: vscode.Range;
}

export class TestModuleNode implements Node {
    readonly name: string;
    readonly parent: TargetNode | TestModuleNode;
    readonly kind = NodeKind.TestModule;
    /// If test module is root of target node, range is all zero
    declarationInfo: TestLocation;
    readonly definitionUri: vscode.Uri;
    readonly testChildren: Set<TestLikeNode> = new Set();

    get testPaths(): string[] {
        if (this.isRootTestModule()) {
            return [];
        }

        assert(this.parent.kind === NodeKind.TestModule);

        return [...this.parent.testPaths, this.name];
    }

    constructor(parent: TargetNode | TestModuleNode, name: string, declarationInfo: TestLocation, definitionUri: vscode.Uri) {
        this.parent = parent;
        this.declarationInfo = declarationInfo;
        this.definitionUri = definitionUri;
        this.name = name;
    }

    public isRootTestModule() {
        return this.parent.kind === NodeKind.Target;
    }
}

export class TestNode implements Node {
    readonly name: string;
    readonly parent: TestModuleNode;
    location: TestLocation;
    readonly kind = NodeKind.Test;

    get testPaths(): string[] {
        return [...this.parent.testPaths, this.name];
    }

    constructor(parent: TestModuleNode, location: TestLocation, name: string) {
        this.parent = parent;
        this.location = location;
        this.name = name;
    }
}

export type Nodes =
    | CargoWorkspaceNode
    | CargoPackageNode
    | TargetNode
    | TestModuleNode
    | TestNode;

export function isTragetNode(node: Nodes): node is TargetNode {
    return node.kind === NodeKind.Target;
}

export function isTestModuleNode(node: Nodes): node is TestModuleNode {
    return node.kind === NodeKind.TestModule;
}

export function isTestNode(node: Nodes): node is TestNode {
    return node.kind === NodeKind.Test;
}

export function isTestLikeNode(node: Nodes): node is TestLikeNode {
    return isTestModuleNode(node) || isTestNode(node);
}

export function getWorkspaceNodeOfTestModelNode(testModel: Nodes) {
    while (testModel.kind !== NodeKind.CargoWorkspace) {
        testModel = testModel.parent;
    }
    return testModel;
}

export function getPackageNodeOfTestModelNode(testModel: TestModuleNode | TargetNode | TestNode | CargoPackageNode) {
    while (testModel.kind !== NodeKind.CargoPackage) {
        testModel = testModel.parent;
    }
    return testModel;
}
