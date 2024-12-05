/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

// just to include
import '../polyfill';
import '../../helpers/peerIdPolyfill';

import cryptoWorker from '../crypto/cryptoMessagePort';
import {setEnvironment} from '../../environment/utils';
import transportController from './transports/controller';
import MTProtoMessagePort from './mtprotoMessagePort';
import appManagersManager from '../appManagers/appManagersManager';
import listenMessagePort from '../../helpers/listenMessagePort';
import {logger} from '../logger';
import {State} from '../../config/state';
import toggleStorages from '../../helpers/toggleStorages';
import appTabsManager from '../appManagers/appTabsManager';
import callbackify from '../../helpers/callbackify';
import Modes from '../../config/modes';
import {ActiveAccountNumber} from '../accounts/types';
import AccountController from '../accounts/accountController';
import commonStateStorage from '../commonStateStorage';

const log = logger('MTPROTO');
// let haveState = false;

const port = new MTProtoMessagePort<false>();
port.addMultipleEventsListeners({
  environment: (environment) => {
    setEnvironment(environment);

    if(import.meta.env.VITE_MTPROTO_AUTO && Modes.multipleTransports) {
      transportController.waitForWebSocket();
    }
  },

  crypto: ({method, args}) => {
    return cryptoWorker.invokeCrypto(method as any, ...args as any);
  },

  state: ({state, resetStorages, pushedKeys, newVersion, oldVersion, userId, accountNumber}) => {
    // if(haveState) {
    //   return;
    // }

    log('got state', accountNumber, state, pushedKeys);

    // console.log('accountNumber', accountNumber);

    const appStateManager = appManagersManager.stateManagersByAccount[accountNumber];
    appStateManager.userId = userId;
    appStateManager.newVersion = newVersion;
    appStateManager.oldVersion = oldVersion;
    // callbackify(appManagersManager.getManagersByAccount(), (managersByAccount) => {
    // });

    // TODO: Understand why is this needed
    appStateManager.resetStoragesPromise.resolve({
      storages: resetStorages,
      callback: async() => {
        for(const key of (Object.keys(state) as any as (keyof State)[])) {
          await appStateManager.pushToState(key, state[key], true, !pushedKeys.includes(key));
        }
      }
    });
    // haveState = true;
  },

  toggleStorages: ({enabled, clearWrite}) => {
    return toggleStorages(enabled, clearWrite);
  },

  event: (payload, source) => {
    log('will redirect event', payload, source);
    port.invokeExceptSource('event', payload, source);
  },

  serviceWorkerOnline: (online) => {
    appManagersManager.isServiceWorkerOnline = online;
  },

  serviceWorkerPort: (payload, source, event) => {
    appManagersManager.onServiceWorkerPort(event);
    port.invokeVoid('receivedServiceMessagePort', undefined, source);
  },

  createObjectURL: (blob) => {
    return URL.createObjectURL(blob);
  }

  // socketProxy: (task) => {
  //   const socketTask = task.payload;
  //   const id = socketTask.id;

  //   const socketProxied = socketsProxied.get(id);
  //   if(socketTask.type === 'message') {
  //     socketProxied.dispatchEvent('message', socketTask.payload);
  //   } else if(socketTask.type === 'open') {
  //     socketProxied.dispatchEvent('open');
  //   } else if(socketTask.type === 'close') {
  //     socketProxied.dispatchEvent('close');
  //     socketsProxied.delete(id);
  //   }
  // },
});

log('MTProto start');

appManagersManager.start();
appManagersManager.getManagersByAccount();
appTabsManager.start();

let isFirst = true;

async function logoutSingleUseAccounts() {
  const managersByAccount = await appManagersManager.getManagersByAccount();

  for(let i = 1; i <= 4; i++) {
    const accountNumber = i as ActiveAccountNumber;

    const managers = managersByAccount[accountNumber];
    const state = await managers.appStateManager.getState();

    const accountData = await AccountController.get(accountNumber);

    if(state.keepSigned !== false || !accountData?.userId) continue;

    // Theoretically requests won't fire until the managers are fully initialized
    managers.apiManager.logOut();
    return;
  }
}

function resetNotificationsCount() {
  commonStateStorage.set({
    notificationsCount: {}
  });
}

listenMessagePort(port, (source) => {
  appTabsManager.addTab(source);
  if(isFirst) {
    isFirst = false;
    logoutSingleUseAccounts();
    resetNotificationsCount();
    // port.invoke('log', 'Shared worker first connection')
  } else {
    callbackify(appManagersManager.getManagersByAccount(), (managers) => {
      for(const key in managers) {
        const accountNumber = key as any as ActiveAccountNumber
        managers[accountNumber].thumbsStorage.mirrorAll(source);
        managers[accountNumber].appPeersManager.mirrorAllPeers(source);
        managers[accountNumber].appMessagesManager.mirrorAllMessages(source);
      }
    });
  }

  // port.invokeVoid('hello', undefined, source);
  // if(!sentHello) {
  //   port.invokeVoid('hello', undefined, source);
  //   sentHello = true;
  // }
}, (source) => {
  appTabsManager.deleteTab(source);
});
