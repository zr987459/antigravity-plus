/**
 * Access Control (Disabled for Clean Edition)
 * 纯净免授权码模式：所有人可直接访问控制台与 API，无阻拦
 */
export class AccessControl {
  constructor() {
    this.adminKey = '';
  }

  load() {}

  save() {}

  get enabled() {
    return false;
  }

  isAdmin() {
    return true;
  }

  static keyFromRequest() {
    return '';
  }
}
