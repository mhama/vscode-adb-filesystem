import * as vscode from 'vscode';
import { Stats } from 'fs';
import adb from '@devicefarmer/adbkit';
const adbClient = adb.createClient();
import { Readable } from 'stream';

export class AdbEntry implements vscode.FileStat {

    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;

    name: string;

    constructor(name: string, type: vscode.FileType) {
        this.type = type;
        this.ctime = Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.name = name;
    }

    static fromStats(stats: Stats): AdbEntry {
        const entryType = stats.isFile() ? vscode.FileType.File : vscode.FileType.Directory;
        const entry = new AdbEntry("", entryType);
        if (stats.isFile()) {
            entry.size = stats.size;
        }
        if (stats.mtime != null) {
            entry.mtime = stats.mtime.getTime();
        }
        return entry;
    }
}

export class AdbFS implements vscode.FileSystemProvider {
    private _deviceTracker: any;
    private _changeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._changeFileEmitter.event;

    async dispose() {
        if (this._deviceTracker) {
            try {
                await this._deviceTracker.end();
            } catch (err) {
                console.error('Error disposing tracker:', err);
            }
        }
    }

    private notifyRootChange(): void {
        this._changeFileEmitter.fire([{ 
            type: vscode.FileChangeType.Changed, 
            uri: vscode.Uri.parse('adb:/') 
        }]);
        vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    }

    async initializeDeviceTracking() {
        try {
            this._deviceTracker = await adbClient.trackDevices();
            
            this._deviceTracker.on('add', async (device: any) => {
                console.log('Device %s was plugged in', device.id);
                this.notifyRootChange();
            });

            this._deviceTracker.on('remove', async (device: any) => {
                console.log('Device %s was unplugged', device.id);
                this.notifyRootChange();
            });

            this._deviceTracker.on('end', () => {
                console.log('Tracking stopped');
            });

            this._deviceTracker.on('error', (err: Error) => {
                console.error('Tracking error:', err);
            });

        } catch (err) {
            console.error('Tracker initialization error:', err);
        }
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        const thenable = new Promise<vscode.FileStat>(async (resolve, reject) => {
            console.log("(promise) stat uri:" + uri);
            const adbpath = this.splitAdbPath(uri);
            console.log("deviceId:" + adbpath.deviceId + " path:" + adbpath.path);
            // check device parent dir
            if (adbpath.deviceId == "" || adbpath.deviceId == null) {
                const entry = new AdbEntry("(devices)", vscode.FileType.Directory);
                resolve(entry);
                return;
            }
            if (adbpath.deviceId == ".vscode") {
                reject("invalid device name \".vscode\"");
                return;
            }
            try {
                const device = adbClient.getDevice(adbpath.deviceId);
                const stats = await device.stat(adbpath.path) as Stats;
                const entry = AdbEntry.fromStats(stats);
                console.log("stat entry:", entry);
                resolve(entry);
            }
            catch(err) {
                /*
                if (err.code == "ENOENT") {
                    console.log("ENOENT received.");
                    reject(vscode.FileSystemError.FileNotFound(uri));
                    return;
                }
                */
                console.error('Something went wrong on stat:', err);
                reject(err);
            }
        });
        return thenable;
    }

    async readDevices(resolve: (value: [string, vscode.FileType][] | PromiseLike<[string, vscode.FileType][]>) => void, reject : any) {
        console.log("adbfs readDevices called.");
        try {
            const devices = await adbClient.listDevices();
            console.log("listDevices result received.", devices);
            let entries: [string, vscode.FileType][] = [];
            entries = devices.map((device) => {
                return [device.id, vscode.FileType.Directory];
            });
            console.log("entries:", entries);
            resolve(entries);
        }
        catch (err) {
            //console.error('Something went wrong:', err.stack)
            console.error('Something went wrong on listDevices:', err);
            reject(""+err);
        }
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        const thenable = new Promise<[string, vscode.FileType][]>(async (resolve, reject) => {
            console.log("(promise) readDirectoryAdb uri:"+uri);
            if (uri.path == "/") {
                this.readDevices(resolve, reject);
                return;
            }
            const adbpath = this.splitAdbPath(uri);
            console.log("deviceId:"+adbpath.deviceId+" path:"+adbpath.path);

            //let entries: [string, vscode.FileType][] = [];

            try {
                const device = adbClient.getDevice(adbpath.deviceId);
                const files = await device.readdir(adbpath.path);
                const sdcardDir = files.find(file => file.name === "sdcard" && !file.isFile());

                // sdcard mode
                // only show contents inside /sdcard folder if sdcardFolderAsRoot setting is true.
                if ((adbpath.path === "/" || adbpath.path === "")) {
                    console.log("getSdcardFolderAsRootSetting(): " + getSdcardFolderOnlyModeSetting() + " sdcardDir:" + sdcardDir);
                    if (getSdcardFolderOnlyModeSetting() && sdcardDir != undefined) {
                        console.log("returns /sdcard directory only");
                        const entries : [string, vscode.FileType][] = [["sdcard", vscode.FileType.Directory]];
                        resolve(entries);
                        return;
                    }
                }

                console.log("readdir files:", files);
                const entries : [string, vscode.FileType][] = files.map((file) => {
                    const entryType = file.isFile() ? vscode.FileType.File : vscode.FileType.Directory;
                    return [file.name, entryType];
                });
                console.log("readdir entries:", entries);
                resolve(entries);
            }
            catch(err) {
                reject(err);
            }
          })
        return thenable;
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        const thenable = new Promise<Uint8Array>(async (resolve, reject) => {
            const adbpath = this.splitAdbPath(uri);
            try {
                const device = adbClient.getDevice(adbpath.deviceId);
                const transfer = await device.pull(adbpath.path);
                const chunks: Buffer[] = [];
                transfer.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                transfer.on('error', reject);
                transfer.on('end', () => {
                    resolve(new Uint8Array(Buffer.concat(chunks)));
                });
            }
            catch(err) {
                reject(err);
            }
        });
        return thenable;
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean, overwrite: boolean }): Thenable<void> {
        const thenable = new Promise<void>(async (resolve, reject) => {
            const adbPath = this.splitAdbPath(uri);
            console.log("writeFile uri:" + uri+ " path:"+adbPath.path);
            //let stream = streamifier.createReadStream(Buffer.from(content));
            const stream = Readable.from(content);
            try {
                const device = adbClient.getDevice(adbPath.deviceId);
                await device.push(stream, adbPath.path)
                console.log("writeFile succeeded.");
                resolve();
            }
            catch(err) {
                reject(err)
            }
        });
        return thenable;
    }

    // overwrite option is not implemented.

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, _options: { overwrite: boolean }): Thenable<void> {
        const thenable = new Promise<void>(async (resolve, reject) => {
            try {
                await this.stat(oldUri);
                console.log("oldUri:"+oldUri+" newUri:"+newUri);
                try {
                    await this.stat(newUri);
                    // if stats exist, can't rename.
                    reject("target file name already exists.")
                }
                catch(err) {
                    // better to pass only "file not found" error.
                }
                console.log("let's mv!");
                const adbPathOld = this.splitAdbPath(oldUri);
                const adbPathNew = this.splitAdbPath(newUri);
                if (adbPathOld.deviceId != adbPathNew.deviceId) {
                    reject("renaming inter-device?");
                    return;
                }
                const device = adbClient.getDevice(adbPathOld.deviceId);
                await device.shell("mv \""+adbPathOld.path+"\" \""+adbPathNew.path+"\"")
                // wait a bit for the change to be settled.
                await this.timeout(300);
                resolve();
            }
            catch(err) {
                reject(err);
            }
        });
        return thenable;
    }

    async deleteEmptyDir(uri: vscode.Uri, resolve: any, reject: any) {
        const adbPath = this.splitAdbPath(uri);
        const cmd = "rmdir \""+adbPath.path+"\"";
        console.log("delete dir adb cmd: "+cmd);
        try {
            const device = adbClient.getDevice(adbPath.deviceId);
            const buf = await device.shell(cmd)
            const output = await adb.util.readAll(buf);
            const msg: string = output.toString().trim();
            console.log('shell output: %s', msg)
            if (msg.endsWith(": Directory not empty")) {
                reject("non-empty directory can't be deleted.");
                return;
            }
            // wait a bit for the change to be settled.
            await this.timeout(300);
            resolve();
        }
        catch(err) {
            reject(err);
        }
    }

    delete(uri: vscode.Uri): Thenable<void> {
        const thenable = new Promise<void>(async (resolve, reject) => {
            try {
                const stats = await this.stat(uri);
                if (stats.type == vscode.FileType.Directory) {
                    this.deleteEmptyDir(uri, resolve, reject);
                    return;
                }
                const adbPath = this.splitAdbPath(uri);
                const cmd = "rm \""+adbPath.path+"\"";
                console.log("delete file adb cmd: "+cmd);
                const device = adbClient.getDevice(adbPath.deviceId);
                await device.shell(cmd);
                // wait a bit for the change to be settled.
                await this.timeout(300);
                resolve();
            }
            catch(err) {
                reject(err);
            }
        });
        return thenable;
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        const thenable = new Promise<void>(async (resolve, reject) => {
            console.log("createDirectory uri:" + uri);
            const adbPath = this.splitAdbPath(uri);
            const cmd = "mkdir \""+adbPath.path+"\"";
            console.log("create dir adb cmd: "+cmd);
            try {
                const device = adbClient.getDevice(adbPath.deviceId);
                await device.shell(cmd);
                // wait a bit for the change to be settled.
                await this.timeout(300);
                resolve();
            }
            catch(err) {
                reject(err);
            }
        });
        return thenable;
    }

    splitAdbPath(uri: vscode.Uri) {
        const parts = uri.path.split('/');
        if (parts[0] == '') {
            parts.shift();
        }
        const deviceId = parts[0];
        parts.shift();
        let path = parts.join("/");

        if (path === "" || path === undefined) {
            path = "/";
        } else {
            path = "/" + path;
        }
        return { "deviceId": deviceId, "path": path };
    }

    watch(_resource: vscode.Uri): vscode.Disposable {
        console.log("adbfs watch uri:"+_resource);
        return new vscode.Disposable(() => { });
    }

    timeout(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

function getSdcardFolderOnlyModeSetting() : boolean
{
	return (vscode.workspace.getConfiguration('adbfs')?.get<boolean>("sdcardFolderOnlyMode") ?? true);
}
