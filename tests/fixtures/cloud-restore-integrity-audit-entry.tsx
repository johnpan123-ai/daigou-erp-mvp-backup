import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthContext } from '../../src/auth/authContext';
import { dataProvider } from '../../src/providers/dataProvider';
import { markCloudReadFresh, markCloudReachable } from '../../src/providers/cloud/cloudConnectivity';

localStorage.setItem('erp_provider_mode', 'cloud');
markCloudReachable(); markCloudReadFresh(5);
dataProvider.waitForCloudBootstrapConvergence = async () => false;
dataProvider.getPendingCloudRestoreAttempts = async () => [];
// Intentionally NOT raw Restore counts; audit must never obtain counts from these reads.
dataProvider.getInventory = async () => Array.from({length:5517}, () => ({})) as Awaited<ReturnType<typeof dataProvider.getInventory>>;
dataProvider.getProductGroups = async () => Array.from({length:705}, () => ({})) as Awaited<ReturnType<typeof dataProvider.getProductGroups>>;
dataProvider.getProductCategories = async () => Array.from({length:390}, () => ({})) as Awaited<ReturnType<typeof dataProvider.getProductCategories>>;
dataProvider.getProductVariants = async () => Array.from({length:3461}, () => ({})) as Awaited<ReturnType<typeof dataProvider.getProductVariants>>;
dataProvider.getSalesOrders = async () => [];
dataProvider.getSalesOrderItems = async () => [];
let writes = 0;
const forbidden = async () => { writes++; throw new Error('FIXTURE_FORBIDDEN_MUTATION'); };
dataProvider.prepareCloudRestoreAttempt = forbidden;
dataProvider.restoreCloudSnapshot = forbidden;
dataProvider.reconcileCloudRestoreAttempt = forbidden;
dataProvider.validateCloudRestoreTarget = forbidden;
const { default: Settings } = await import('../../src/pages/Settings');
const root = createRoot(document.getElementById('root')!);
const user = { id:'00000000-0000-4000-8000-000000000099', app_metadata:{}, user_metadata:{}, aud:'authenticated',created_at:'2026-09-21T00:00:00Z' };
let key = 0;
const render = (role: 'owner' | 'staff' | null = 'owner', mode = 'cloud') => {
  localStorage.setItem('erp_provider_mode',mode);
  root.render(<React.StrictMode><AuthContext.Provider value={{
    user:role ? user:null, profile:role ? {role,display_name:'Audit fixture',is_active:true}:null,
    loading:false,profileLoading:false,authFlow:'normal',
    signInWithPassword:async()=>{},requestPasswordReset:async()=>{},setNewPassword:async()=>{},signOut:async()=>{},
  }}><Settings key={++key}/></AuthContext.Provider></React.StrictMode>);
};
declare global {
  interface Window {
    __RESTORE_AUDIT__: { render: typeof render; writes: () => number };
  }
}
window.__RESTORE_AUDIT__ = {render,writes:()=>writes};
render();
