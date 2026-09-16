/**
 * @deprecated Use `core/twake/calendar` instead. This file is a
 * backwards-compatibility shim for setups that still load the plugin under
 * its historical name, which undersold it: besides resources, it propagates
 * user identity changes (email, first and last name) to Twake Calendar. It
 * will be removed in a future major release.
 *
 * The instance keeps registering as `calendarResources`, so code looking it
 * up by that name keeps finding it.
 */
import Calendar from './calendar';

console.warn(
  '[ldap-rest] Plugin `core/twake/calendarResources` is deprecated; use `core/twake/calendar` instead.'
);

export default class CalendarResources extends Calendar {
  name = 'calendarResources';
}
