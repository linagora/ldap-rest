/*
 * SPDX-License-Identifier: BSD-3-Clause
 */
package org.lscproject.ldaprest;

import java.lang.reflect.Method;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.lsc.LscDatasetModification;
import org.lsc.LscDatasetModification.LscDatasetModificationType;
import org.lsc.LscDatasets;
import org.lsc.LscModifications;
import org.lsc.beans.IBean;
import org.lsc.configuration.ConnectionType;
import org.lsc.configuration.TaskType;
import org.lsc.exception.LscServiceException;
import org.lsc.service.IWritableService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * LSC {@link IWritableService} that writes through the ldap-rest
 * HTTP API.
 *
 * <p>Configuration is read from the {@code <pluginDestinationService>}
 * element in {@code lsc.xml}; LSC hands us the parsed {@link TaskType}
 * and we extract our parameters from
 * {@code task.getPluginDestinationService().getAny()} (a list of DOM
 * elements). Recognised parameters:</p>
 *
 * <ul>
 *     <li>{@code <baseUrl>} — required, e.g. {@code https://ldap-rest.example.org}</li>
 *     <li>{@code <resourceType>} — required, one of {@code users},
 *         {@code groups}, {@code organizations}, …</li>
 *     <li>{@code <auth>} block containing either {@code <bearer>} or
 *         {@code <hmacServiceId>}+{@code <hmacSecret>}</li>
 *     <li>{@code <timeoutMs>} — optional, default 10000ms</li>
 *     <li>{@code <retries>} — optional, default 3</li>
 *     <li>{@code <apiPrefix>} — optional, default {@code /api}</li>
 * </ul>
 *
 * <p>This service is purely <strong>destination</strong>: the read
 * methods ({@code getBean}, {@code getListPivots}) are stubbed
 * because LSC pulls source records from a separate source service
 * and only feeds us {@link LscModifications}. They return empty
 * structures so the framework does not crash if it ever calls
 * them.</p>
 */
public class LdapRestDstService implements IWritableService {

    private static final Logger LOG = LoggerFactory.getLogger(LdapRestDstService.class);

    private final LdapRestClient client;
    private final ResourceMapper mapper;
    private final ModificationTranslator translator;
    private final List<String> writeDatasetIds;

    /**
     * LSC constructor signature. Called once per task before sync.
     */
    public LdapRestDstService(TaskType task) throws LscServiceException {
        Config cfg = parseConfig(task);
        this.mapper = new ResourceMapper(cfg.resourceType, cfg.apiPrefix);
        this.translator = new ModificationTranslator(this.mapper);
        this.client = new LdapRestClient(cfg.baseUrl, cfg.auth, cfg.timeoutMs, cfg.retries);
        this.writeDatasetIds = cfg.writeDatasetIds;
        LOG.info("ldap-rest plugin destination service initialised: baseUrl={}, resourceType={}, "
                        + "auth={}, timeoutMs={}, retries={}",
                cfg.baseUrl, cfg.resourceType, cfg.auth.getClass().getSimpleName(),
                cfg.timeoutMs, cfg.retries);
    }

    /** Test-only constructor injecting an already-built client. */
    LdapRestDstService(LdapRestClient client, ResourceMapper mapper) {
        this.client = client;
        this.mapper = mapper;
        this.translator = new ModificationTranslator(mapper);
        this.writeDatasetIds = Collections.emptyList();
    }

    @Override
    public boolean apply(LscModifications lm) throws LscServiceException {
        if (lm == null || lm.getOperation() == null) {
            throw new LscServiceException("LscModifications has no operation");
        }
        switch (lm.getOperation()) {
            case CREATE_OBJECT:
                return doCreate(lm);
            case UPDATE_OBJECT:
                return doUpdate(lm);
            case DELETE_OBJECT:
                return doDelete(lm);
            case CHANGE_ID:
                return doModrdn(lm);
            default:
                throw new LscServiceException("Unsupported LSC operation: " + lm.getOperation());
        }
    }

    private boolean doCreate(LscModifications lm) throws LscServiceException {
        String body = translator.buildCreateBody(lm);
        String path = mapper.collectionPath();
        HttpResponse<String> resp = client.post(path, body);
        LOG.debug("CREATE {} -> {}", path, resp.statusCode());
        return true;
    }

    private boolean doUpdate(LscModifications lm) throws LscServiceException {
        // For UPDATE on group, member-mutating attributes must use
        // the dedicated /members endpoints; ldap-rest itself enforces
        // this. We split the payload accordingly.
        if (mapper.getFamily() == ResourceMapper.Family.GROUPS) {
            return doGroupUpdate(lm);
        }
        String body = translator.buildUpdateBody(lm);
        String path = mapper.itemPath(lm.getMainIdentifier());
        HttpResponse<String> resp = client.put(path, body);
        LOG.debug("UPDATE {} -> {}", path, resp.statusCode());
        return true;
    }

    /**
     * Group updates are special: ldap-rest forbids touching the
     * {@code member} attribute through PUT and exposes dedicated
     * member endpoints. We extract member ADD/DELETE operations
     * first, fire dedicated calls for each, then fall back to PUT
     * for non-member attribute changes.
     */
    private boolean doGroupUpdate(LscModifications lm) throws LscServiceException {
        List<LscDatasetModification> rest = new ArrayList<>();
        List<Object> addedMembers = new ArrayList<>();
        List<Object> removedMembers = new ArrayList<>();
        boolean replaceMembers = false;
        List<Object> replacedMembers = Collections.emptyList();

        for (LscDatasetModification mod : safeList(lm.getLscAttributeModifications())) {
            if ("member".equalsIgnoreCase(mod.getAttributeName())) {
                List<Object> values = mod.getValues() == null ? Collections.emptyList() : mod.getValues();
                switch (mod.getOperation()) {
                    case ADD_VALUES:
                        addedMembers.addAll(values);
                        break;
                    case DELETE_VALUES:
                        if (values.isEmpty()) {
                            // attribute-wide delete on `member` — would mean
                            // "remove all members". ldap-rest has no clear-
                            // members endpoint, and we don't fetch the
                            // current list (destination-only). Refuse loudly
                            // rather than silently drop.
                            throw new LscServiceException(
                                "attribute-wide DELETE on group 'member' is not supported by this plugin; "
                                + "emit explicit DELETE_VALUES with the current member list "
                                + "or use REPLACE_VALUES with the new (possibly empty) member list");
                        }
                        removedMembers.addAll(values);
                        break;
                    case REPLACE_VALUES:
                        replaceMembers = true;
                        replacedMembers = new ArrayList<>(values);
                        break;
                    default:
                        break;
                }
            } else {
                rest.add(mod);
            }
        }

        // Apply replace-members as a (delete-all + add-all) sequence
        // because ldap-rest has no "replace members" endpoint.
        if (replaceMembers) {
            // We don't currently fetch the existing list (this service
            // is destination-only) so we approximate by removing the
            // explicit additions/removals first, then adding the new
            // set. Operators wanting a full reconciliation should use
            // ADD_VALUES/DELETE_VALUES explicitly in their sync map.
            LOG.warn("REPLACE on group 'member' is best-effort: missing members will not be removed."
                    + " Use ADD_VALUES/DELETE_VALUES for deterministic group sync.");
            addedMembers.addAll(replacedMembers);
        }

        for (Object m : addedMembers) {
            String memberDn = String.valueOf(m);
            String path = mapper.membersPath(lm.getMainIdentifier());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("member", memberDn);
            client.post(path, ModificationTranslator.writeJson(body));
        }
        for (Object m : removedMembers) {
            String memberDn = String.valueOf(m);
            String path = mapper.memberItemPath(lm.getMainIdentifier(), memberDn);
            client.delete(path);
        }

        if (!rest.isEmpty()) {
            LscModifications stripped = new LscModifications(lm.getOperation(), lm.getTaskName());
            stripped.setMainIdentifer(lm.getMainIdentifier());
            stripped.setNewMainIdentifier(lm.getNewMainIdentifier());
            stripped.setLscAttributeModifications(rest);
            String body = translator.buildUpdateBody(stripped);
            // Avoid an empty PUT (no buckets) when only members changed.
            if (!"{}".equals(body)) {
                String path = mapper.itemPath(lm.getMainIdentifier());
                client.put(path, body);
            }
        }
        return true;
    }

    private boolean doDelete(LscModifications lm) throws LscServiceException {
        String path = mapper.itemPath(lm.getMainIdentifier());
        try {
            HttpResponse<String> resp = client.delete(path);
            LOG.debug("DELETE {} -> {}", path, resp.statusCode());
            return true;
        } catch (LscServiceException e) {
            // 404 on DELETE = soft idempotence
            String msg = e.getMessage();
            if (msg != null && msg.contains("HTTP 404")) {
                LOG.warn("DELETE {} returned 404 — already absent, treating as success", path);
                return true;
            }
            throw e;
        }
    }

    private boolean doModrdn(LscModifications lm) throws LscServiceException {
        ModificationTranslator.ModrdnPayload payload = translator.buildModrdnPayload(lm);
        String path;
        if (payload.kind == ModificationTranslator.ModrdnKind.RENAME) {
            path = mapper.renamePath(lm.getMainIdentifier());
        } else {
            path = mapper.movePath(lm.getMainIdentifier());
        }
        HttpResponse<String> resp = client.post(path, payload.body);
        LOG.debug("MODRDN {} {} -> {}", payload.kind, path, resp.statusCode());
        return true;
    }

    @Override
    public List<String> getWriteDatasetIds() {
        return writeDatasetIds == null ? Collections.emptyList() : writeDatasetIds;
    }

    /**
     * Read-side: this service is destination-only. LSC requires the
     * methods to exist (because {@link IWritableService} extends
     * {@code IService}) but we are never the source. Returning empty
     * structures keeps LSC happy in defensive code paths.
     */
    @Override
    public IBean getBean(String pivotName, LscDatasets pivotAttributes, boolean fromSameService)
            throws LscServiceException {
        LOG.debug("getBean({}) called on destination-only service — returning null", pivotName);
        return null;
    }

    @Override
    public Map<String, LscDatasets> getListPivots() throws LscServiceException {
        LOG.debug("getListPivots() called on destination-only service — returning empty map");
        return new HashMap<>();
    }

    @Override
    public Collection<Class<? extends ConnectionType>> getSupportedConnectionType() {
        // We do not bind to a typed LSC connection (no LDAP, no JDBC);
        // ldap-rest auth is configured inline. Return empty so LSC
        // doesn't try to inject one.
        return Collections.emptyList();
    }

    // -------------------------------------------------------------------
    // configuration parsing
    // -------------------------------------------------------------------

    static class Config {
        String baseUrl;
        String resourceType;
        String apiPrefix = "/api";
        long timeoutMs = 10_000L;
        int retries = 3;
        LdapRestAuth auth;
        List<String> writeDatasetIds = new ArrayList<>();
    }

    static Config parseConfig(TaskType task) throws LscServiceException {
        if (task == null) {
            throw new LscServiceException("ldap-rest plugin: TaskType is null");
        }
        List<Element> elements = extractAnyElements(task);
        Config cfg = new Config();
        Element authElement = null;
        for (Element e : elements) {
            String name = localName(e);
            String text = textOf(e).trim();
            switch (name) {
                case "baseUrl":
                    cfg.baseUrl = text;
                    break;
                case "resourceType":
                    cfg.resourceType = text;
                    break;
                case "apiPrefix":
                    if (!text.isEmpty()) cfg.apiPrefix = normaliseApiPrefix(text);
                    break;
                case "timeoutMs":
                    if (!text.isEmpty()) {
                        try {
                            cfg.timeoutMs = Long.parseLong(text);
                        } catch (NumberFormatException nfe) {
                            throw new LscServiceException("invalid <timeoutMs>: " + text);
                        }
                        if (cfg.timeoutMs <= 0) {
                            throw new LscServiceException("<timeoutMs> must be > 0, got: " + cfg.timeoutMs);
                        }
                    }
                    break;
                case "retries":
                    if (!text.isEmpty()) {
                        try {
                            cfg.retries = Integer.parseInt(text);
                        } catch (NumberFormatException nfe) {
                            throw new LscServiceException("invalid <retries>: " + text);
                        }
                        if (cfg.retries < 0) {
                            throw new LscServiceException("<retries> must be >= 0, got: " + cfg.retries);
                        }
                    }
                    break;
                case "auth":
                    authElement = e;
                    break;
                case "writeDatasetIds":
                case "writeDatasetId":
                    if (!text.isEmpty()) {
                        for (String s : text.split(",")) {
                            String t = s.trim();
                            if (!t.isEmpty()) cfg.writeDatasetIds.add(t);
                        }
                    }
                    break;
                default:
                    LOG.debug("ldap-rest plugin: ignoring unknown config element <{}>", name);
            }
        }

        if (cfg.baseUrl == null || cfg.baseUrl.isEmpty()) {
            throw new LscServiceException("ldap-rest plugin: <baseUrl> is required");
        }
        if (cfg.resourceType == null || cfg.resourceType.isEmpty()) {
            throw new LscServiceException("ldap-rest plugin: <resourceType> is required");
        }
        cfg.auth = parseAuth(authElement);
        return cfg;
    }

    static LdapRestAuth parseAuth(Element authElement) throws LscServiceException {
        if (authElement == null) {
            throw new LscServiceException(
                    "ldap-rest plugin: <auth> block missing — provide <bearer> or "
                            + "<hmacServiceId>+<hmacSecret>");
        }
        String bearer = childText(authElement, "bearer");
        String svcId = childText(authElement, "hmacServiceId");
        String secret = childText(authElement, "hmacSecret");
        if (bearer != null && !bearer.isEmpty()) {
            return new BearerAuth(bearer);
        }
        if (svcId != null && secret != null && !svcId.isEmpty() && !secret.isEmpty()) {
            return new HmacAuth(svcId, secret);
        }
        throw new LscServiceException(
                "ldap-rest plugin: <auth> needs either <bearer> or both "
                        + "<hmacServiceId> and <hmacSecret>");
    }

    /**
     * Normalise {@code <apiPrefix>}: ensure leading {@code /}, strip
     * trailing {@code /}. So {@code "api"}, {@code "/api"}, {@code "/api/"}
     * all become {@code "/api"}. Also accepts the empty prefix {@code "/"}.
     */
    static String normaliseApiPrefix(String raw) {
        String s = raw.trim();
        if (s.isEmpty() || "/".equals(s)) return "";
        if (!s.startsWith("/")) s = "/" + s;
        while (s.length() > 1 && s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /**
     * Reflectively call {@code task.getPluginDestinationService().getAny()}
     * and filter out non-Element entries (whitespace text nodes,
     * comments, etc.). This keeps us compatible with subtle JAXB
     * binding differences across LSC versions.
     */
    @SuppressWarnings("unchecked")
    static List<Element> extractAnyElements(TaskType task) throws LscServiceException {
        List<Element> out = new ArrayList<>();
        try {
            Method getPlugin = task.getClass().getMethod("getPluginDestinationService");
            Object plugin = getPlugin.invoke(task);
            if (plugin == null) {
                throw new LscServiceException(
                        "ldap-rest plugin: <pluginDestinationService> not configured");
            }
            Method getAny = plugin.getClass().getMethod("getAny");
            Object any = getAny.invoke(plugin);
            if (any instanceof List) {
                for (Object o : (List<Object>) any) {
                    if (o instanceof Element) {
                        out.add((Element) o);
                    } else if (o instanceof Node) {
                        Node n = (Node) o;
                        if (n.getNodeType() == Node.ELEMENT_NODE) {
                            out.add((Element) n);
                        }
                    }
                }
            } else {
                LOG.warn("ldap-rest plugin: getAny() returned non-List ({}); ignoring",
                        any == null ? "null" : any.getClass().getName());
            }
        } catch (NoSuchMethodException nsme) {
            throw new LscServiceException(
                    "ldap-rest plugin: incompatible LSC version (missing "
                            + "getPluginDestinationService/getAny): " + nsme.getMessage(), nsme);
        } catch (ReflectiveOperationException roe) {
            throw new LscServiceException(
                    "ldap-rest plugin: failed to read configuration: " + roe.getMessage(), roe);
        }
        return out;
    }

    static String localName(Element e) {
        String n = e.getLocalName();
        if (n != null) return n;
        n = e.getNodeName();
        int colon = n.indexOf(':');
        return colon < 0 ? n : n.substring(colon + 1);
    }

    static String childText(Element parent, String childName) {
        NodeList kids = parent.getChildNodes();
        for (int i = 0; i < kids.getLength(); i++) {
            Node n = kids.item(i);
            if (n.getNodeType() == Node.ELEMENT_NODE
                    && childName.equalsIgnoreCase(localName((Element) n))) {
                return textOf((Element) n).trim();
            }
        }
        return null;
    }

    static String textOf(Element e) {
        StringBuilder sb = new StringBuilder();
        NodeList kids = e.getChildNodes();
        for (int i = 0; i < kids.getLength(); i++) {
            Node n = kids.item(i);
            if (n.getNodeType() == Node.TEXT_NODE
                    || n.getNodeType() == Node.CDATA_SECTION_NODE) {
                String v = n.getNodeValue();
                if (v != null) sb.append(v);
            }
        }
        return sb.toString();
    }

    private static <T> List<T> safeList(List<T> l) {
        return l == null ? Collections.emptyList() : l;
    }

    /** Test seam to expose internals to the integration test. */
    LdapRestClient client() { return client; }
    ResourceMapper mapper() { return mapper; }

    @SuppressWarnings("unused")
    private static String safeUpper(String s) {
        return s == null ? "" : s.toUpperCase(Locale.ROOT);
    }
}
