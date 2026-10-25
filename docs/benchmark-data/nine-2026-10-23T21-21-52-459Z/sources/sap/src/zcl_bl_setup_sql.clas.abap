CLASS zcl_bl_setup_sql DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_bl_setup_sql IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    " Local trial setup only. Standard API enforces parameter administration
    " authorization and rejects parameters which cannot change dynamically.
    DATA names TYPE STANDARD TABLE OF spfl_parameter_name WITH EMPTY KEY.
    names = VALUE #( ( CONV #( 'wssql/active' ) )
                     ( CONV #( 'wssql/privileged/active' ) ) ).
    LOOP AT names INTO DATA(name).
      DATA metadata TYPE spfl_parameter_metadata.
      DATA value TYPE spfl_parameter_value.
      DATA(rc) = cl_spfl_profile_parameter=>get_metadata(
        EXPORTING name = name IMPORTING metadata = metadata ).
      IF rc <> 0 OR metadata-is_dynamic <> '1'.
        out->write( |{ name } NOT_DYNAMIC rc={ rc }| ).
        RETURN.
      ENDIF.
      rc = cl_spfl_profile_parameter=>get_value(
        EXPORTING name = name IMPORTING value = value ).
      out->write( |{ name } before={ value } read_rc={ rc }| ).
      IF rc <> 0.
        RETURN.
      ENDIF.
      IF value <> '1'.
        rc = cl_spfl_profile_parameter=>change_value( name = name value = '1' ).
        out->write( |{ name } change_rc={ rc }| ).
        IF rc <> 0.
          RETURN.
        ENDIF.
      ENDIF.
      rc = cl_spfl_profile_parameter=>get_value(
        EXPORTING name = name IMPORTING value = value ).
      out->write( |{ name } after={ value } read_rc={ rc }| ).
    ENDLOOP.
    AUTHORITY-CHECK OBJECT 'S_SQL_VIEW'
      ID 'SQL_SCHEMA' FIELD 'ZUI_BL_ORDERS_SQL'
      ID 'SQL_VIEW' FIELD 'ZI_BL_OrderPosition'
      ID 'SQL_VIEWOP' FIELD 'SELECT'.
    out->write( |S_SQL_VIEW SELECT rc={ sy-subrc }| ).
    AUTHORITY-CHECK OBJECT 'S_START'
      ID 'AUTHPGMID' FIELD 'R3TR'
      ID 'AUTHOBJTYP' FIELD 'SQL1'
      ID 'AUTHOBJNAM' FIELD 'S_PRIVILEGED'.
    out->write( |S_START SQL1 S_PRIVILEGED rc={ sy-subrc }| ).
  ENDMETHOD.
ENDCLASS.
