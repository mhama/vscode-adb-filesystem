import * as vscode from 'vscode';
import { Stats } from 'fs';
import adb from '@devicefarmer/adbkit';
//const adb = require('adbkit');
const adbClient = adb.createClient();
const concatStream = require('concat-stream');
const streamifier = require('streamifier');

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
        let entryType = stats.isFile() ? vscode.FileType.File : vscode.FileType.Directory;
        let entry = new AdbEntry("", entryType);
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

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        let thenable = new Promise<vscode.FileStat>(async (resolve, reject) => {
            console.log("(promise) stat uri:" + uri);
            var adbpath = this.splitAdbPath(uri);
            console.log("deviceId:" + adbpath.deviceId + " path:" + adbpath.path);
            // check device parent dir
            if (adbpath.deviceId == "" || adbpath.deviceId == null) {
                let entry = new AdbEntry("(devices)", vscode.FileType.Directory);
                resolve(entry);
                return;
            }
            if (adbpath.deviceId == ".vscode") {
                reject("invalid device name \".vscode\"");
                return;
            }
            try {
                const device = adbClient.getDevice(adbpath.deviceId);
                let stats = await device.stat(adbpath.path) as Stats;
                let entry = AdbEntry.fromStats(stats);
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
            let devices = await adbClient.listDevices();
            console.log("listDevices result received.", devices);
            let entries: [string, vscode.FileType][] = [];
            entries = devices.map((device: any) => {
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
        let thenable = new Promise<[string, vscode.FileType][]>(async (resolve, reject) => {
            console.log("(promise) readDirectoryAdb uri:"+uri);
            if (uri.path == "/") {
                this.readDevices(resolve, reject);
                return;
            }
            var adbpath = this.splitAdbPath(uri);

            console.log("deviceId:"+adbpath.deviceId+" path:"+adbpath.path);
            try {
                const device = adbClient.getDevice(adbpath.deviceId);
                let files = await device.readdir(adbpath.path)
                console.log("readdir files:", files);
                let entries: [string, vscode.FileType][] = [];
                entries = files.map((file: any) => {
                    let entryType = file.isFile() ? vscode.FileType.File : vscode.FileType.Directory;
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
        let thenable = new Promise<Uint8Array>(async (resolve, reject) => {
            var adbpath = this.splitAdbPath(uri);
            try {
                const device = adbClient.getDevice(adbpath.deviceId);
                var transfer = await device.pull(adbpath.path)
                var writable = concatStream({
                    encoding: 'uint8array'
                }, (data: any) => {
                    resolve(data);
                });
                transfer.on('error', reject)
                transfer.pipe(writable);
            }
            catch(err) {
                reject(err);
            }
        });
        return thenable;
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Thenable<void> {
        let thenable = new Promise<void>(async (resolve, reject) => {
            let adbPath = this.splitAdbPath(uri);
            console.log("writeFile uri:" + uri+ " path:"+adbPath.path);
            let stream = streamifier.createReadStream(Buffer.from(content));
            try {
                let device = adbClient.getDevice(adbPath.deviceId);
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

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Thenable<void> {
        let thenable = new Promise<void>(async (resolve, reject) => {
            try {
                let stats = await this.stat(oldUri);
                console.log("oldUri:"+oldUri+" newUri:"+newUri);
                try {
                    let stats = await this.stat(newUri);
                    // if stats exist, can't rename.
                    reject("target file name already exists.")
                }
                catch(err) {
                    // better to pass only "file not found" error.
                }
                console.log("let's mv!");
                let adbPathOld = this.splitAdbPath(oldUri);
                let adbPathNew = this.splitAdbPath(newUri);
                if (adbPathOld.deviceId != adbPathNew.deviceId) {
                    reject("renaming inter-device?");
                    return;
                }
                let device = adbClient.getDevice(adbPathOld.deviceId);
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
        let adbPath = this.splitAdbPath(uri);
        let cmd = "rmdir \""+adbPath.path+"\"";
        console.log("delete dir adb cmd: "+cmd);
        try {
            let device = adbClient.getDevice(adbPath.deviceId);
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
        let thenable = new Promise<void>(async (resolve, reject) => {
            try {
                let stats = await this.stat(uri);
                if (stats.type == vscode.FileType.Directory) {
                    this.deleteEmptyDir(uri, resolve, reject);
                    return;
                }
                let adbPath = this.splitAdbPath(uri);
                let cmd = "rm \""+adbPath.path+"\"";
                console.log("delete file adb cmd: "+cmd);
                let device = adbClient.getDevice(adbPath.deviceId);
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
        let thenable = new Promise<void>(async (resolve, reject) => {
            console.log("createDirectory uri:" + uri);
            let adbPath = this.splitAdbPath(uri);
            let cmd = "mkdir \""+adbPath.path+"\"";
            console.log("create dir adb cmd: "+cmd);
            try {
                let device = adbClient.getDevice(adbPath.deviceId);
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

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    // TODO: implement onDidChangeFile

    splitAdbPath(uri: vscode.Uri) {
        let parts = uri.path.split('/');
        if (parts[0] == '') {
            parts.shift();
        }
        let deviceId = parts[0];
        parts.shift();
        let path = parts.join("/");
        if (path == "") {
            path = "/sdcard";
        } else {
            path = "/sdcard/" + path;
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
