/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from 'vs/base/common/event';
import { IPCServer, ClientConnectionEvent } from 'vs/base/parts/ipc/common/ipc';
import { Protocol } from 'vs/base/parts/ipc/node/ipc.electron';
import { ipcMain } from 'electron';
import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { VSBuffer } from 'vs/base/common/buffer';

///IPC事件
interface IIPCEvent {
	event: { sender: Electron.WebContents; };
	message: Buffer | null;
}

/// 创建受限范围的消息事件，所注册监听器只响应由ipcMain接受到的来自senderID的eventName事件
/// 所产生的事件（注册处理器）的注册效果，类似于ipcMain.on(eventName, (e)=>{if(e.source.id==senderId){ listener.call(e) }})
function createScopedOnMessageEvent(senderId: number, eventName: string): Event<VSBuffer | null> {
	const onMessage = Event.fromNodeEventEmitter<IIPCEvent>(ipcMain, eventName, (event, message) => ({ event, message }));
	const onMessageFromSender = Event.filter(onMessage, ({ event }) => event.sender.id === senderId);
	return Event.map(onMessageFromSender, ({ message }) => message ? VSBuffer.wrap(message) : message);
}

export class Server extends IPCServer {

	private static Clients = new Map<number, IDisposable>();

	/// 产出Event<ClientConnectionEvent>，客户端连接事件
	private static getOnDidClientConnect(): Event<ClientConnectionEvent> {
		/// 注册ipcMain接受到'ipc:hello'时响应的监听器
		const onHello = Event.fromNodeEventEmitter<Electron.WebContents>(ipcMain, 'ipc:hello', ({ sender }) => sender);

		/// 该事件响应消息时，将webContents转换为{ protocol, onDidClientDisconnect }
		/// protocol只响应ipcMain接收到来自webContents的ipc::message消息
		return Event.map(onHello, webContents => {
			const id = webContents.id;
			const client = Server.Clients.get(id);

			if (client) {
				client.dispose();
			}

			const onDidClientReconnect = new Emitter<void>();
			Server.Clients.set(id, toDisposable(() => onDidClientReconnect.fire()));

			const onMessage = createScopedOnMessageEvent(id, 'ipc:message') as Event<VSBuffer>;
			const onDidClientDisconnect = Event.any(Event.signal(createScopedOnMessageEvent(id, 'ipc:disconnect')), onDidClientReconnect.event);
			const protocol = new Protocol(webContents, onMessage);

			return { protocol, onDidClientDisconnect };
		});
	}

	constructor() {

		super(Server.getOnDidClientConnect());
	}
}