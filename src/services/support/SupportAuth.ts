export interface SupportAuth { requestCode(technician:string):Promise<{code:string;mock:true}>; verifyCode(code:string):Promise<boolean> }
export const mockSupportAuth:SupportAuth={async requestCode(_technician){return {code:'MOCK-0000',mock:true}},async verifyCode(code){return code==='MOCK-0000'}};
